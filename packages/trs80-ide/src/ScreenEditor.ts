
import {EditorView} from "@codemirror/view"
import {TRS80_SCREEN_BEGIN, TRS80_SCREEN_SIZE } from 'trs80-base';
import { Trs80 } from 'trs80-emulator';
import { CanvasScreen, ScreenMouseEvent } from 'trs80-emulator-web';
import { toHexByte } from 'z80-base';
import {AssemblyResults} from "./AssemblyResults.js";

/**
 * Lets the user edit the screen with a paintbrush. Instantiate one of these
 * for each click of the Edit button.
 */
export class ScreenEditor {
    private readonly view: EditorView;
    private readonly screen: CanvasScreen;
    private readonly raster = new Uint8Array(TRS80_SCREEN_SIZE);
    private readonly begin: number;
    private end: number;
    private mouseDown = false;

    constructor(view: EditorView, pos: number, assemblyResults: AssemblyResults,
                screenshotIndex: number, trs80: Trs80, screen: CanvasScreen) {

        this.view = view;
        this.screen = screen;
        screen.mouseActivity.subscribe(e => this.handleMouse(e));

        trs80.stop();

        const s = assemblyResults.screenshotSections[screenshotIndex];
        if (s.firstDataLineNumber !== undefined && s.lastDataLineNumber !== undefined) {
            let i = 0;
            for (let lineNumber = s.firstDataLineNumber; lineNumber <= s.lastDataLineNumber; lineNumber++) {
                const line = assemblyResults.sourceFile.assembledLines[lineNumber - 1];
                for (const c of line.binary) {
                    if (i === this.raster.length) {
                        break;
                    }
                    this.raster[i++] = c;
                }
            }
            this.begin = view.state.doc.line(s.firstDataLineNumber).from;
            this.end = view.state.doc.line(s.lastDataLineNumber).to;
        } else {
            // No data lines at all, insert after comment line.
            this.begin = view.state.doc.line(s.beginCommentLineNumber).to + 1;
            this.end = this.begin;
        }

        this.rasterToScreen();
    }

    /**
     * Write our raster array back to the source code.
     */
    private rasterToCode() {
        const lines = [];
        for (let i = 0; i < this.raster.length; i += 8) {
            const bytes = Array.from(this.raster.subarray(i, i + 8));
            const bytesStrings = bytes.map(b => "0x" + toHexByte(b));
            // TODO guess the indent.
            // TODO guess ASCII and use .text.
            lines.push(`        .byte ${bytesStrings.join(",")}`);
        }
        const code = lines.join("\n");

        const change = {
            from: this.begin,
            to: this.end,
            insert: code,
        };
        this.view.dispatch({changes: change});

        // Update end.
        this.end = this.begin + code.length;
    }

    /**
     * Write our raster array to the TRS-80 screen.
     */
    private rasterToScreen() {
        for (let i = 0; i < TRS80_SCREEN_SIZE; i++) {
            this.screen.writeChar(TRS80_SCREEN_BEGIN + i, this.raster[i]);
        }
    }

    /**
     * Handle a mouse event and update both our raster array and the TRS-80 screen.
     */
    private handleMouse(e: ScreenMouseEvent) {
        if (e.type === "mousedown") {
            this.mouseDown = true;
        }
        if (e.type === "mouseup") {
            this.mouseDown = false;
            this.rasterToCode();
        }
        const position = e.position;
        if ((e.type === "mousedown" || this.mouseDown) && position !== undefined) {
            let ch = this.raster[position.offset];
            if (ch < 128 || ch >= 192) {
                ch = 128;
            }
            ch |= position.mask | 0x80;
            this.raster[position.offset] = ch;
            this.screen.writeChar(position.address, ch);
        }
    }
}
