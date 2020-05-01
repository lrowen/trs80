import CodeMirror from "codemirror";
import {Asm, AssembledLine, FileInfo, SymbolInfo, SymbolReference} from "../assembler/Asm";
import mnemonicData from "../assembler/Opcodes";
import {toHexByte, toHexWord} from "z80-base";
import tippy from 'tippy.js';

import 'tippy.js/dist/tippy.css';
import "codemirror/lib/codemirror.css";
import "codemirror/theme/mbo.css";
import "codemirror/addon/dialog/dialog.css";
import "codemirror/addon/hint/show-hint.css";
import "codemirror/addon/fold/foldgutter.css";
import "./main.css";

// Load these for their side-effects (they register themselves).
import "codemirror/addon/dialog/dialog";
import "codemirror/addon/search/search";
import "codemirror/addon/search/jump-to-line";
import "codemirror/addon/edit/closebrackets";
import "codemirror/addon/hint/show-hint";
import "codemirror/addon/scroll/annotatescrollbar";
import "codemirror/addon/selection/active-line";
import "codemirror/addon/selection/mark-selection";
import "codemirror/addon/fold/foldcode";
import "codemirror/addon/fold/foldgutter";
import "codemirror/mode/z80/z80";

import * as fs from "fs";
import Store from "electron-store";
import {ClrInstruction, OpcodeTemplate, Variant} from "../assembler/OpcodesTypes";
import {toHex} from "z80-base/dist/main";

// Max number of sub-lines per line. These are lines where we display the
// opcodes for a single source line.
const MAX_SUBLINES = 100;

// Max number of opcode bytes we display per subline. Sync this with the CSS
// that lays out the gutter.
const BYTES_PER_SUBLINE = 3;

const CURRENT_PATHNAME_KEY = "current-pathname";

// Convenience for the result of a range finder function (for folding).
type RangeFinderResult = {from: CodeMirror.Position, to: CodeMirror.Position} | undefined;

// Result of looking up what symbol we're on.
class SymbolHit {
    public readonly symbol: SymbolInfo;
    // Undefined if it's the definition.
    public readonly referenceNumber: number | undefined;

    constructor(symbol: SymbolInfo, reference: number | undefined) {
        this.symbol = symbol;
        this.referenceNumber = reference;
    }
}

// In-memory cache of the disk file.
class SourceFile {
    public readonly pathname: string;
    public readonly lines: string[];
    public modified = false;

    constructor(pathname: string, lines: string[]) {
        this.pathname = pathname;
        this.lines = lines;
    }

    public setLines(lines: string[]): void {
        console.log("Pushing " + lines.length + " lines to " + this.pathname);
        // See if they've changed.
        let changed = this.lines.length !== lines.length;
        if (!changed) {
            const length = lines.length;
            for (let i = 0; i < length; i++) {
                if (this.lines[i] !== lines[i]) {
                    changed = true;
                    break;
                }
            }
        }

        if (changed) {
            console.log("Was modified");
            this.lines.splice(0, this.lines.length, ...lines);
            this.modified = true;
        }
    }
}

// Read a file raw text, or undefined if the file can't be opened.
function readFile(pathname: string): string | undefined {
    try {
        return fs.readFileSync(pathname, "utf-8");
    } catch (e) {
        console.log("readFile(" + pathname + "): " + e);
        return undefined;
    }
}

// Read a file as an array of lines, or undefined if the file can't be opened.
function readFileLines(pathname: string): string[] | undefined {
    const text = readFile(pathname);
    return text === undefined ? undefined : text.split(/\r?\n/);
}

/**
 * Whether "prefix" is a prefix of "opcode". I.e., the opcode array starts with prefix.
 */
function isPrefix(prefix: OpcodeTemplate[], opcode: OpcodeTemplate[]): boolean {
    if (prefix.length > opcode.length) {
        return false;
    }

    for (let i = 0; i < prefix.length; i++) {
        if (prefix[i] !== opcode[i]) {
            return false;
        }
    }

    return true;
}

class Ide {
    private store: Store;
    private readonly cm: CodeMirror.Editor;
    // The index of this array is the line number in the file (zero-based).
    private assembled: AssembledLine[] = [];
    private symbols = new Map<string,SymbolInfo>();
    private pathname: string = "";
    private ipcRenderer: any;
    private scrollbarAnnotator: any;
    private sourceFiles = new Map<string,SourceFile>();
    private readonly symbolMarks: CodeMirror.TextMarker[] = [];
    private readonly lineWidgets: CodeMirror.LineWidget[] = [];
    private fileInfo: FileInfo | undefined;
    private lineNumberToFileInfo = new Map<number,FileInfo>();

    constructor(parent: HTMLElement) {
        this.store = new Store({
            name: "z80-ide",
        });

        const config = {
            value: "",
            lineNumbers: true,
            tabSize: 8,
            theme: 'mbo',
            gutters: ["CodeMirror-linenumbers", "gutter-assembled", "CodeMirror-foldgutter"],
            autoCloseBrackets: true,
            mode: "text/x-z80",
            // Doesn't work, I call focus() explicitly later.
            autoFocus: true,
            extraKeys: (CodeMirror as any).normalizeKeyMap({
                // "Ctrl-Space": "autocomplete"
                "Cmd-B": () => this.jumpToDefinition(false),
                "Shift-Cmd-B": () => this.jumpToDefinition(true),
            }),
            hintOptions: {
                hint: () => this.hint(),
            },
            styleActiveLine: true,
            styleSelectedText: true,
            cursorScrollMargin: 200,
            foldGutter: true,
            foldOptions: {
                rangeFinder: (cm: CodeMirror.Editor, start: CodeMirror.Position) => this.rangeFinder(start),
                widget: (from: CodeMirror.Position, to: CodeMirror.Position) => {
                    const count = to.line - from.line;
                    return `\u21A4 ${count} \u21A6`;
                },
            },
        };
        this.cm = CodeMirror(parent, config);

        // Create CSS classes for our line heights. We do this dynamically since
        // we don't know the line height at compile time.
        const cssRules = [];
        for (let lineCount = 1; lineCount < MAX_SUBLINES; lineCount++) {
            cssRules.push(".line-height-" + lineCount + " { height: " + lineCount * this.cm.defaultTextHeight() + "px; }");
        }
        const style = document.createElement("style");
        style.appendChild(document.createTextNode(cssRules.join("\n")));
        document.head.appendChild(style);

        this.cm.on("change", (instance, changeObj) => {
            // It's important to call this in "change", and not in "changes" or
            // after a timeout, because we want to be part of this operation.
            // This way a large re-assemble takes 40ms instead of 300ms.

            // We should be entirely within a file (otherwise we would have gotten
            // canceled in the "beforeChange" event). Find which file we're in
            // and update it all.
            if (changeObj.origin !== "setValue") {
                console.log(changeObj);
                const removed = changeObj.removed ?? [];
                const linesAdded = changeObj.text.length - removed.length;
                this.editorToCache(changeObj.from.line, linesAdded);
            }
            this.assembleAll();
        });
        this.cm.on("beforeChange", (instance, changeObj) => {
            if (changeObj.origin === "setValue") {
                // Always allow setValue().
                return;
            }
            console.log("beforeChange \"" + changeObj.origin + "\"");
            const beginLine = changeObj.from.line;
            const endLine = changeObj.to.ch === 0 ? changeObj.to.line : changeObj.to.line + 1;

            if (this.fileInfo !== undefined) {
                const spansFileInfo = (fileInfo: FileInfo): boolean => {
                    if ((beginLine < fileInfo.beginLineNumber && endLine > fileInfo.beginLineNumber) ||
                        (beginLine < fileInfo.endLineNumber && endLine > fileInfo.endLineNumber)) {

                        return true;
                    }
                    for (const fi of fileInfo.childFiles) {
                        if (spansFileInfo(fi)) {
                            return true;
                        }
                    }

                    return false;
                };
                const spanFile = spansFileInfo(this.fileInfo);
                if (spanFile) {
                    console.log("Canceling update");
                    changeObj.cancel();
                }
            }
        });

        this.cm.on("cursorActivity", (instance) => {
            this.updateHighlight();
        });

        this.cm.on("blur", () => this.saveSilently());

        // The type definition doesn't include this extension.
        this.scrollbarAnnotator = (this.cm as any).annotateScrollbar("scrollbar-error");

        // Configure IPC with the main process of Electron.
        this.ipcRenderer = (window as any).ipcRenderer;
        this.ipcRenderer.on("set-text", (event: any, pathname: string, text: string) => this.setText(pathname, text));
        this.ipcRenderer.on("next-error", () => this.nextError());
        this.ipcRenderer.on("declaration-or-usages", () => this.jumpToDefinition(false));
        this.ipcRenderer.on("next-usage", () => this.jumpToDefinition(true));
        this.ipcRenderer.on("save", () => this.saveOrAskPathname());
        this.ipcRenderer.on("asked-for-filename", (event: any, pathname: string | undefined) => this.userSpecifiedPathname(pathname));
        this.ipcRenderer.on("fold-all", () => (CodeMirror.commands as any).foldAll(this.cm));
        this.ipcRenderer.on("unfold-all", () => (CodeMirror.commands as any).unfoldAll(this.cm));

        this.cm.focus();

        // Read file from last time.
        const pathname = this.store.get(CURRENT_PATHNAME_KEY);
        if (pathname !== undefined) {
            const text = readFile(pathname);
            if (text !== undefined) {
                this.pathname = pathname;
                this.assembleAll();
            }
        }
    }

    private setText(pathname: string, text: string): void {
        this.setPathname(pathname);
        this.assembleAll();
    }

    private setPathname(pathname: string) {
        this.pathname = pathname;
        this.store.set(CURRENT_PATHNAME_KEY, pathname);
    }

    // Save if possible, else do nothing. This is for implicit saving like when the editor
    // loses focus.
    private saveSilently(): void {
        if (this.pathname !== "") {
            this.saveFile();
        }
    }

    // User-initiated save.
    private saveOrAskPathname(): void {
        if (this.pathname === "") {
            this.ipcRenderer.send("ask-for-filename");
            // Continues in "asked-for-filename".
        } else {
            this.saveFile();
        }
    }

    private userSpecifiedPathname(pathname: string | undefined): void {
        if (pathname === undefined) {
            // Ignore.
        } else {
            this.setPathname(pathname);
            this.saveFile();
        }
    }

    // Save the file to disk.
    private saveFile(): void {
        /*
        fs.writeFile(this.pathname, this.cm.getValue(), () => {
            // TODO mark file clean.
        });

         */
    }

    // Given a starting line, see if it starts a section that could be folded.
    private rangeFinder(start: CodeMirror.Position): RangeFinderResult {
        const checkFileInfo = (fi: FileInfo | undefined, depth: number): RangeFinderResult => {
            if (fi !== undefined) {
                // Prefer children, do those first.
                for (const child of fi.childFiles) {
                    const range = checkFileInfo(child, depth + 1);
                    if (range !== undefined) {
                        return range;
                    }
                }

                // Assume that whatever is being folded, it's the result of an #include statement
                // on the previous line. Don't need to fold entire top-level file.
                if (fi.beginLineNumber - 1 === start.line && depth > 0) {
                    const firstLineNumber = start.line;
                    const firstLine = this.cm.getLine(firstLineNumber);
                    const lastLineNumber = fi.endLineNumber - 1;
                    const lastLine = this.cm.getLine(lastLineNumber);
                    if (firstLine !== undefined && lastLine !== undefined) {
                        return {
                            from: CodeMirror.Pos(firstLineNumber, firstLine.length),
                            to: CodeMirror.Pos(lastLineNumber, lastLine.length),
                        };
                    }
                }
            }

            return undefined;
        };

        return checkFileInfo(this.fileInfo, 0);
    }

    private nextError(): void {
        if (this.assembled.length === 0) {
            return;
        }

        const currentLineNumber = this.cm.getCursor().line;
        let nextErrorLineNumber = currentLineNumber;
        do {
            nextErrorLineNumber = (nextErrorLineNumber + 1) % this.assembled.length;
        } while (nextErrorLineNumber !== currentLineNumber && this.assembled[nextErrorLineNumber].error === undefined);

        if (nextErrorLineNumber !== currentLineNumber) {
            // TODO error might not be in this file:
            this.setCursor(nextErrorLineNumber, 0);
        }
    }

    private setCursorToReference(ref: SymbolReference): void {
        this.setCursor(ref.lineNumber, ref.column);
    }

    // Set the editor's cursor if it's for this file.
    private setCursor(lineNumber: number, column: number): void {
        this.cm.setCursor(lineNumber, column);
    }

    // Find symbol usage at a location, or undefined if we're not on a symbol.
    private findSymbolAt(lineNumber: number, column: number): SymbolHit | undefined {
        for (const symbol of this.symbols.values()) {
            // See if we're at the definition.
            if (symbol.matches(symbol.definition, lineNumber, column)) {
                return new SymbolHit(symbol, undefined);
            } else {
                // See if we're at a use.
                for (let i = 0; i < symbol.references.length; i++) {
                    if (symbol.matches(symbol.references[i], lineNumber, column)) {
                        return new SymbolHit(symbol, i);
                    }
                }
            }
        }

        return undefined;
    }

    // Jump from a use to its definition and vice versa.
    //
    // @param nextUse whether to jump to the next use if we're on one (true) or go to the definition (false).
    private jumpToDefinition(nextUse: boolean) {
        const pos = this.cm.getCursor();
        const symbolHit = this.findSymbolAt(pos.line, pos.ch);
        if (symbolHit !== undefined) {
            const symbol = symbolHit.symbol;

            if (symbolHit.referenceNumber === undefined) {
                if (symbol.references.length > 0) {
                    // Jump to first use.
                    const reference = symbol.references[0];
                    this.setCursorToReference(reference);
                } else {
                    // TODO display error.
                }
            } else {
                if (nextUse) {
                    const reference = symbol.references[(symbolHit.referenceNumber + 1) % symbol.references.length];
                    this.setCursorToReference(reference);
                } else {
                    this.setCursorToReference(symbol.definition);
                }
            }
        }
    }

    // Delete all line widgets.
    private clearLineWidgets(): void {
        let lineWidget;

        while ((lineWidget = this.lineWidgets.pop()) !== undefined) {
            lineWidget.clear();
        }
    }

    private clearSymbolMarks(): void {
        let mark;

        while ((mark = this.symbolMarks.pop()) !== undefined) {
            mark.clear();
        }
    }

    private updateHighlight() {
        this.clearSymbolMarks();

        const pos = this.cm.getCursor();
        const symbolHit = this.findSymbolAt(pos.line, pos.ch);
        if (symbolHit !== undefined) {
            const symbol = symbolHit.symbol;

            const mark = this.cm.markText({line: symbol.definition.lineNumber, ch: symbol.definition.column},
                {line: symbol.definition.lineNumber, ch: symbol.definition.column + symbol.name.length},
                {
                    className: "current-symbol",
                });
            this.symbolMarks.push(mark);

            for (const reference of symbol.references) {
                const mark = this.cm.markText({line: reference.lineNumber, ch: reference.column},
                    {line: reference.lineNumber, ch: reference.column + symbol.name.length},
                    {
                        className: "current-symbol",
                    });
                this.symbolMarks.push(mark);
            }
        }
    }

    // Push the lines in the editor back to the file cache.
    private editorToCache(beginLineNumber: number, linesAdded: number): void {
        if (this.fileInfo === undefined) {
            // Haven't assembled yet.
            return;
        }

        // Find the file we're in.
        const fileInfo = this.lineNumberToFileInfo.get(beginLineNumber);
        if (fileInfo === undefined) {
            throw new Error("Can't find line info for line " + beginLineNumber);
        }

        const sourceFile = this.sourceFiles.get(fileInfo.pathname);
        if (sourceFile === undefined) {
            throw new Error("Can't find source file for " + fileInfo.pathname);
        }

        let lineNumbers = new Array<number>(... fileInfo.lineNumbers);
        if (linesAdded > 0) {
            console.log(lineNumbers);
            const index = lineNumbers.indexOf(beginLineNumber);
            if (index === -1) {
                throw new Error("Can't find line number " + beginLineNumber + " in array of lines");
            }
            for (let i = 0; i < linesAdded; i++) {
                lineNumbers.splice(index + 1 + i, 0, beginLineNumber + i + 1);
            }
            console.log(lineNumbers);
            for (let i = index + linesAdded + 1; i < lineNumbers.length; i++) {
                lineNumbers[i] += linesAdded;
            }
            console.log(lineNumbers);
        } else if (linesAdded < 0) {
            const linesRemoved = -linesAdded;
            console.log(lineNumbers);
            const index = lineNumbers.indexOf(beginLineNumber);
            if (index === -1) {
                throw new Error("Can't find line number " + beginLineNumber + " in array of lines");
            }
            lineNumbers.splice(index + 1, linesRemoved);
            console.log(lineNumbers);
            for (let i = index + 1; i < lineNumbers.length; i++) {
                lineNumbers[i] -= linesRemoved;
            }
            console.log(lineNumbers);

        } else {
            lineNumbers = fileInfo.lineNumbers;
        }

        if (this.fileInfo.mark !== undefined) {
            // TODO delete.
            console.log("mark: " + this.fileInfo.mark.find().from.line + " to " + this.fileInfo.mark.find().to.line);
        }

        const newLines: string[] = [];
        for (const lineNumber of lineNumbers) {
            const text = this.cm.getLine(lineNumber);
            newLines.push(text);
        }

        sourceFile.setLines(newLines);
    }

    // Get the lines from the file cache, reading from disk if necessary.
    private getFileLines(pathname: string): string[] | undefined {
        // Check the cache.
        let sourceFile = this.sourceFiles.get(pathname);
        if (sourceFile === undefined) {
            const lines = readFileLines(pathname);
            if (lines === undefined) {
                // Don't cache the failure, just try again next time.
                return undefined;
            }
            sourceFile = new SourceFile(pathname, lines);
            this.sourceFiles.set(pathname, sourceFile);
        }
        return sourceFile.lines;
    }

    private assembleAll() {
        this.clearLineWidgets();

        const before = Date.now();
        const asm = new Asm((pathname) => this.getFileLines(pathname));
        this.assembled = asm.assembleFile(this.pathname) ?? []; // TODO deal with file not existing.
        this.symbols = asm.symbols;
        this.fileInfo = asm.fileInfo;
        console.log("Number of assembled lines: " + this.assembled.length);

        const lines: string[] = [];
        for (const assembledLine of this.assembled) {
            const sourceFile = this.sourceFiles.get(assembledLine.pathname);
            // TODO fix ???
            const line = sourceFile === undefined ? "???" : sourceFile.lines[assembledLine.lineNumber];
            lines.push(line);
        }
        console.log("Number of source lines: " + lines.length);

        let newValue = lines.join("\n");
        if (newValue !== this.cm.getValue()) {
            console.log("Changing " + newValue.length);
            this.cm.setValue(newValue);
        } else {
            console.log("Unchanged");
        }

        // Update text markers.
        const processFileInfo = (fileInfo: FileInfo, depth: number) => {
            for (let lineNumber = fileInfo.beginLineNumber; lineNumber < fileInfo.endLineNumber; lineNumber++) {
                this.lineNumberToFileInfo.set(lineNumber, fileInfo);
                if (depth > 0) {
                    this.cm.addLineClass(lineNumber, "background", "include-" + depth);
                }
            }
            if (depth > 0 && false) {
                fileInfo.mark = this.cm.markText(
                    { line: fileInfo.beginLineNumber, ch: 0 },
                    { line: fileInfo.endLineNumber, ch: 0 },
                    {
                        inclusiveLeft: true,
                        inclusiveRight: true,
                        css: "background: #00" + toHex(depth * 50, 2) + "00",
                    });
            }
            fileInfo.childFiles.forEach(fi => processFileInfo(fi, depth + 1));
        };
        if (this.fileInfo != undefined) {
            this.lineNumberToFileInfo.clear();
            processFileInfo(this.fileInfo, 0);
        }

        // Update UI.
        const annotationMarks: any[] = [];
        for (let lineNumber = 0; lineNumber < this.assembled.length; lineNumber++) {
            const results = this.assembled[lineNumber];

            let addressElement: HTMLElement | null;
            if (results.binary.length > 0) {
                addressElement = document.createElement("div");

                // Break opcodes over multiple lines if necessary.
                let numLines = 0;
                for (let offset = 0;
                     offset < results.binary.length && numLines < MAX_SUBLINES;
                     offset += BYTES_PER_SUBLINE, numLines++) {

                    const addressString = toHexWord(results.address + offset) +
                        "  " + results.binary.slice(offset, offset + BYTES_PER_SUBLINE).map(toHexByte).join(" ");
                    const addressTextElement = document.createTextNode(addressString);
                    if (offset > 0) {
                        addressElement.appendChild(document.createElement("br"));
                    }
                    addressElement.appendChild(addressTextElement);
                }
                addressElement.classList.add("gutter-style");

                // For the line height using CSS.
                this.cm.removeLineClass(lineNumber, "wrap", undefined);
                if (numLines !== 1) {
                    this.cm.addLineClass(lineNumber, "wrap", "line-height-" + numLines);
                }

                if (results.variant !== undefined) {
                    let popup = results.variant.clr !== null
                        ? this.getPopupForClr(results.variant.clr)
                        : this.getPopupForPseudoInstruction(results.variant);
                    if (popup !== undefined) {
                        addressElement.addEventListener("mouseenter", event => {
                            if (addressElement !== null && (addressElement as any)._tippy === undefined) {
                                const instance = tippy(addressElement, {
                                    content: popup,
                                    allowHTML: true,
                                });
                                instance.show();
                            }
                        });
                    }
                }
            } else {
                addressElement = null;
            }
            this.cm.setGutterMarker(lineNumber, "gutter-assembled", addressElement);

            if (results.error === undefined) {
                this.cm.removeLineClass(lineNumber, "background", "error-line");
            } else {
                // Highlight error in scrollbar.
                annotationMarks.push({
                    from: { line: lineNumber, ch: 0 },
                    to: { line: lineNumber + 1, ch: 0 },
                });

                // Write error below line.
                const node = document.createElement("span");
                node.appendChild(document.createTextNode(results.error));
                this.lineWidgets.push(this.cm.addLineWidget(lineNumber, node, {
                    className: "error-line",
                }));
            }
        }

        this.scrollbarAnnotator.update(annotationMarks);

        const after = Date.now();
        console.log("Assembly time: " + (after - before));
    }

    private hint(): any {
        // TODO remove.
        const cursor = this.cm.getCursor();
        const line = this.cm.getLine(cursor.line);
        const start = cursor.ch;
        const end = cursor.ch;

        return {
            list: ["aaaaa", "bbbbb", "ccccc"],
            from: CodeMirror.Pos(cursor.line, start - 3),
            to: CodeMirror.Pos(cursor.line, start),
        };
    }

    /**
     * Generate a popup for an instruction that has clr info.
     */
    private getPopupForClr(clr: ClrInstruction) {
        let popup = "<b>" + clr.instruction.toUpperCase() + "</b><br><br>";
        if (clr.description) {
            popup += clr.description + "<br><br>";
        }
        popup += clr.byte_count + " bytes, ";
        if (clr.with_jump_clock_count === clr.without_jump_clock_count) {
            popup += clr.with_jump_clock_count + " clocks.<br><br>";
        } else {
            popup += clr.with_jump_clock_count + "/" + clr.without_jump_clock_count + " clocks.<br><br>";
        }

        if (clr.flags === "------") {
            popup += "Flags are unaffected.</br>";
        } else {
            const flagLabels = ['C', 'N', 'P/V', 'H', 'Z', 'S'];

            for (let i = 0; i < 6; i++) {
                popup += "<b>" + flagLabels[i] + ":</b> ";

                switch (clr.flags.charAt(i)) {
                    case '-':
                        popup += 'unaffected';
                        break;
                    case '+':
                        popup += 'affected as defined';
                        break;
                    case 'P':
                        popup += 'detects parity';
                        break;
                    case 'V':
                        popup += 'detects overflow';
                        break;
                    case '1':
                        popup += 'set';
                        break;
                    case '0':
                        popup += 'reset';
                        break;
                    case '*':
                        popup += 'exceptional';
                        break;
                    default:
                        popup += 'unknown';
                        break;
                }
                popup += "<br>";
            }
        }

        if (clr.undocumented) {
            popup += "<br>Undocumented instructions.<br>";
        }

        return popup;
    }

    /**
     * Generate popup for a pseudo instruction (composite of multiple instructions),
     * or undefined if we can't find which instructions it's made of.
     */
    private getPopupForPseudoInstruction(variant: Variant): string | undefined {
        if (variant.opcode.length === 0) {
            return undefined;
        }

        let popup = "<b>Pseudo Instruction</b><br><br>";

        // If this happens a lot we should make a reverse map.
        let start = 0;
        while (start < variant.opcode.length) {
            const subVariant = this.getVariantForOpcode(variant.opcode.slice(start));
            if (subVariant === undefined) {
                return undefined;
            }

            if (subVariant.clr === null) {
                popup += "Unknown instruction<br>";
            } else {
                popup += subVariant.clr.instruction.toUpperCase() + "<br>";
            }

            start += subVariant.opcode.length;
        }

        return popup;
    }

    /**
     * Find the variant for whatever instruction is at the head of the sequence of opcodes,
     * or undefined if it can't be found. Never returns pseudo-instructions.
     */
    private getVariantForOpcode(opcode: OpcodeTemplate[]): Variant | undefined {
        for (const mnemonic of Object.keys(mnemonicData.mnemonics)) {
            for (const variant of mnemonicData.mnemonics[mnemonic].variants) {
                if (variant.clr !== null && isPrefix(variant.opcode, opcode)) {
                    return variant;
                }
            }
        }

        return undefined;
    }
}

function main() {
    const element = document.getElementById("editor") as HTMLElement;
    new Ide(element);
}

main();
