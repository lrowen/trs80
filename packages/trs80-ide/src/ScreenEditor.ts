import {EditorView} from "@codemirror/view";
import {ChangeSpec} from "@codemirror/state";
import {TRS80_SCREEN_BEGIN, TRS80_SCREEN_SIZE} from 'trs80-base';
import {Trs80} from 'trs80-emulator';
import {CanvasScreen, ScreenMouseEvent, ScreenMousePosition} from 'trs80-emulator-web';
import {toHexByte} from 'z80-base';
import {AssemblyResults} from "./AssemblyResults.js";

enum Mode {
    DRAW, ERASE,
}

enum Tool {
    PENCIL, LINE, BUCKET,
}

/**
 * Lets the user edit the screen with a paintbrush. Instantiate one of these
 * for each click of the Edit button.
 */
export class ScreenEditor {
    private readonly view: EditorView;
    private readonly screen: CanvasScreen;
    private readonly trs80: Trs80;
    private readonly onClose: () => void;
    private readonly mouseUnsubscribe: () => void;
    private readonly raster = new Uint8Array(TRS80_SCREEN_SIZE);
    private readonly rasterBackup = new Uint8Array(TRS80_SCREEN_SIZE);
    private readonly extraBytes: number[];
    private readonly begin: number;
    private readonly controlPanelDiv: HTMLDivElement;
    private end: number;
    private byteCount: number;
    private mouseDownPosition: ScreenMousePosition | undefined = undefined;
    private previousPosition: ScreenMousePosition | undefined = undefined;
    private mode: Mode = Mode.DRAW;
    private tool: Tool = Tool.PENCIL;
    private showPixelGrid = false;
    private showCharGrid = false;

    constructor(view: EditorView, pos: number, assemblyResults: AssemblyResults,
                screenshotIndex: number, trs80: Trs80, screen: CanvasScreen, onClose: () => void) {

        this.view = view;
        this.screen = screen;
        this.trs80 = trs80;
        this.onClose = onClose;
        this.mouseUnsubscribe = screen.mouseActivity.subscribe(e => this.handleMouse(e));

        trs80.stop();

        this.controlPanelDiv = document.createElement("div");
        this.controlPanelDiv.style.position = "absolute";
        this.controlPanelDiv.style.top = "-50px";
        screen.getNode().append(this.controlPanelDiv);

        let button = document.createElement("button");
        button.innerText = "Save";
        button.addEventListener("click", () => {
            this.close(true);
        });
        this.controlPanelDiv.append(button);

        button = document.createElement("button");
        button.innerText = "Cancel";
        button.addEventListener("click", () => {
            this.close(false);
        });
        this.controlPanelDiv.append(button);

        button = document.createElement("button");
        button.innerText = "Draw";
        button.addEventListener("click", () => {
            this.mode = Mode.DRAW;
        });
        this.controlPanelDiv.append(button);

        button = document.createElement("button");
        button.innerText = "Erase";
        button.addEventListener("click", () => {
            this.mode = Mode.ERASE;
        });
        this.controlPanelDiv.append(button);

        button = document.createElement("button");
        button.innerText = "Pixel Grid";
        button.addEventListener("click", () => {
            this.showPixelGrid = !this.showPixelGrid;
            this.screen.showGrid(this.showPixelGrid, this.showCharGrid);
        });
        this.controlPanelDiv.append(button);

        button = document.createElement("button");
        button.innerText = "Char Grid";
        button.addEventListener("click", () => {
            this.showCharGrid = !this.showCharGrid;
            this.screen.showGrid(this.showPixelGrid, this.showCharGrid);
        });
        this.controlPanelDiv.append(button);

        button = document.createElement("button");
        button.innerText = "Pencil";
        button.addEventListener("click", () => {
            this.tool = Tool.PENCIL;
        });
        this.controlPanelDiv.append(button);

        button = document.createElement("button");
        button.innerText = "Line";
        button.addEventListener("click", () => {
            this.tool = Tool.LINE;
        });
        this.controlPanelDiv.append(button);

        button = document.createElement("button");
        button.innerText = "Bucket";
        button.addEventListener("click", () => {
            this.tool = Tool.BUCKET;
        });
        this.controlPanelDiv.append(button);

        // Fill with blanks.
        this.raster.fill(0x80);

        const s = assemblyResults.screenshotSections[screenshotIndex];
        this.byteCount = s.byteCount;
        this.extraBytes = [];
        if (s.firstDataLineNumber !== undefined && s.lastDataLineNumber !== undefined) {
            let i = 0;
            for (let lineNumber = s.firstDataLineNumber; lineNumber <= s.lastDataLineNumber; lineNumber++) {
                const line = assemblyResults.sourceFile.assembledLines[lineNumber - 1];
                const length = Math.min(line.binary.length, this.raster.length - i);
                for (let j = 0; j < length; j++) {
                    this.raster[i++] = line.binary[j];
                }
                if (length < line.binary.length) {
                    this.extraBytes = line.binary.slice(length);
                    break;
                }
            }
            this.begin = view.state.doc.line(s.firstDataLineNumber).from;
            this.end = view.state.doc.line(s.lastDataLineNumber).to;
        } else {
            // No data lines at all, insert after comment line.
            this.begin = view.state.doc.line(s.beginCommentLineNumber).to + 1;
            this.end = this.begin;
        }

        this.screen.showGrid(this.showPixelGrid, this.showCharGrid);
        this.rasterToScreen();
    }

    private close(save: boolean) {
        if (save) {
            this.rasterToCode();
        }
        this.screen.showGrid(false, false);
        this.trs80.start();
        this.mouseUnsubscribe();
        this.controlPanelDiv.remove();
        this.onClose();
    }

    /**
     * Write our raster array back to the source code.
     */
    private rasterToCode() {
        const lines = [];
        const raster = Array.from(this.raster.subarray(0, this.byteCount));
        for (let i = 0; i < raster.length; i += 8) {
            const bytes = raster.slice(i, i + 8);
            const bytesStrings = bytes.map(b => "0x" + toHexByte(b));
            // TODO guess the indent.
            // TODO guess ASCII and use .text.
            let text = `        .byte ${bytesStrings.join(",")}`;
            if (i % 64 == 0) {
                text += ` ; Line ${i / 64}`;
            }
            lines.push(text);
        }
        if (this.extraBytes.length > 0) {
            const bytesStrings = this.extraBytes.map(b => "0x" + toHexByte(b));
            let text = `        .byte ${bytesStrings.join(",")} ; Extra data`;
            lines.push(text);
        }
        const code = lines.join("\n");

        // Update doc.
        let change: ChangeSpec;
        const docLength = this.view.state.doc.length;
        if (this.begin > docLength) {
            // We're at the very end of the doc, must insert another newline.
            change = {
                from: docLength,
                to: docLength,
                insert: "\n" + code,
            };
        } else {
            change = {
                from: this.begin,
                to: this.end,
                insert: code,
            };
        }
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
        const position = e.position;

        if (e.type === "mousedown") {
            switch (this.tool) {
                case Tool.PENCIL:
                    this.mouseDownPosition = e.position;
                    this.previousPosition = e.position;
                    break;
                case Tool.LINE:
                    this.mouseDownPosition = e.position;
                    this.previousPosition = undefined;
                    this.rasterBackup.set(this.raster);
                    break;
                case Tool.BUCKET:
                    if (position !== undefined) {
                        this.floodFill(position, this.mode == Mode.DRAW);
                    }
                    break;
            }
        }
        if (e.type === "mouseup") {
            this.mouseDownPosition = undefined;
            this.previousPosition = undefined;
        }
        switch (this.tool) {
            case Tool.PENCIL:
                if (this.previousPosition != undefined && position !== undefined) {
                    this.drawLine(this.previousPosition, position, this.mode == Mode.DRAW);
                    this.previousPosition = position;
                }
                break;
            case Tool.LINE:
                if (this.mouseDownPosition != undefined && position !== undefined) {
                    this.raster.set(this.rasterBackup);
                    this.rasterToScreen();
                    this.drawLine(this.mouseDownPosition, position, this.mode == Mode.DRAW);
                }
                break;
            case Tool.BUCKET:
                break;
        }
    }

    /**
     * Draw a line from p1 to p2 of the specified value.
     */
    private drawLine(p1: ScreenMousePosition, p2: ScreenMousePosition, value: boolean): void {
        if (Math.abs(p2.pixelX - p1.pixelX) >= Math.abs(p2.pixelY - p1.pixelY)) {
            // More across than vertical.

            // Order left-to-right.
            if (p1.pixelX > p2.pixelX) {
                [p1, p2] = [p2, p1];
            }

            const dx = p2.pixelX - p1.pixelX;
            const dy = p2.pixelY - p1.pixelY;
            const slope = dy/dx;

            let y = p1.pixelY;
            for (let x = p1.pixelX; x <= p2.pixelX; x++) {
                this.setPixel(x, Math.round(y), value);
                y += slope;
            }
        } else {
            // More vertical than across.

            // Order top-to-bottom.
            if (p1.pixelY > p2.pixelY) {
                [p1, p2] = [p2, p1];
            }

            const dx = p2.pixelX - p1.pixelX;
            const dy = p2.pixelY - p1.pixelY;
            const slope = dx/dy;

            let x = p1.pixelX;
            for (let y = p1.pixelY; y <= p2.pixelY; y++) {
                this.setPixel(Math.round(x), y, value);
                x += slope;
            }
        }
    }

    /**
     * Turn the specified pixel on or off.
     */
    private setPixel(x: number, y: number, value: boolean): void {
        this.setPosition(new ScreenMousePosition(x, y), value);
    }

    /**
     * Turn the specified position on or off.
     */
    private setPosition(position: ScreenMousePosition, value: boolean): void {
        let ch = this.raster[position.offset];
        if (ch < 128 || ch >= 192) {
            // Convert to graphics.
            ch = 128;
        }
        if (value) {
            ch |= position.mask;
        } else {
            ch &= ~position.mask;
        }
        this.raster[position.offset] = ch;
        this.screen.writeChar(position.address, ch);
        this.byteCount = Math.max(this.byteCount, position.offset + 1);
    }

    /**
     * Flood fill from the given position with the given value.
     */
    private floodFill(position: ScreenMousePosition, value: boolean): void {
        const pixels: ScreenMousePosition[] = [position];

        while (pixels.length > 0) {
            position = pixels.pop() as ScreenMousePosition;

            const pixelValue = this.getPosition(position);
            if (pixelValue !== value) {
                this.setPosition(position, value);

                const x = position.pixelX;
                const y = position.pixelY;
                if (x > 0) pixels.push(new ScreenMousePosition(x - 1, y));
                if (x < 127) pixels.push(new ScreenMousePosition(x + 1, y));
                if (y > 0) pixels.push(new ScreenMousePosition(x, y - 1));
                if (y < 47) pixels.push(new ScreenMousePosition(x, y + 1));
            }
        }
    }

    /**
     * Get the pixel value at the given position.
     */
    private getPosition(position: ScreenMousePosition): boolean {
        const ch = this.raster[position.offset];
        if (ch < 128 || ch >= 192) {
            return false;
        } else {
            return (ch & position.mask) !== 0;
        }
    }
}
