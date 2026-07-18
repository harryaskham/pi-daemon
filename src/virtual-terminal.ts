import { visibleWidth, type Terminal } from "@earendil-works/pi-tui";

export interface VirtualTerminalLimits {
  readonly maxColumns: number;
  readonly maxRows: number;
  readonly maxWriteBytes: number;
  readonly maxEscapeBytes: number;
  readonly maxInputBytes: number;
  readonly maxTitleBytes: number;
  readonly maxFrameBytes: number;
}

export const DEFAULT_VIRTUAL_TERMINAL_LIMITS: VirtualTerminalLimits = Object.freeze({
  maxColumns: 320,
  maxRows: 200,
  maxWriteBytes: 1024 * 1024,
  maxEscapeBytes: 64 * 1024,
  maxInputBytes: 16 * 1024,
  maxTitleBytes: 512,
  maxFrameBytes: 512 * 1024,
});

export type VirtualTerminalColor =
  | { readonly mode: "indexed"; readonly value: number }
  | { readonly mode: "rgb"; readonly red: number; readonly green: number; readonly blue: number };

export interface VirtualTerminalStyle {
  readonly foreground?: VirtualTerminalColor;
  readonly background?: VirtualTerminalColor;
  readonly bold?: true;
  readonly dim?: true;
  readonly italic?: true;
  readonly underline?: true;
  readonly inverse?: true;
  readonly strikethrough?: true;
  readonly href?: string;
}

export interface VirtualTerminalRun {
  readonly text: string;
  readonly columns: number;
  readonly style: VirtualTerminalStyle;
}

export interface VirtualTerminalRowDelta {
  readonly row: number;
  readonly text: string;
  readonly runs: readonly VirtualTerminalRun[];
}

export interface VirtualTerminalCursor {
  readonly row: number;
  readonly column: number;
  readonly visible: boolean;
}

export interface VirtualTerminalStrippedSequences {
  readonly osc52: number;
  readonly oscOther: number;
  readonly deviceControl: number;
  readonly kittyGraphics: number;
  readonly unsupportedCsi: number;
  readonly controlCharacters: number;
}

export interface VirtualTerminalFrame {
  readonly sequence: number;
  readonly columns: number;
  readonly rows: number;
  readonly full: boolean;
  readonly changedRows: readonly VirtualTerminalRowDelta[];
  readonly cursor: VirtualTerminalCursor;
  readonly title: string;
  readonly progress: boolean;
  readonly writes: number;
  readonly acceptedBytes: number;
  readonly stripped: VirtualTerminalStrippedSequences;
}

interface MutableStyle {
  foreground?: VirtualTerminalColor;
  background?: VirtualTerminalColor;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  inverse?: true;
  strikethrough?: true;
  href?: string;
}

interface Cell {
  text: string;
  width: 1 | 2;
  continuation: boolean;
  style: MutableStyle;
}

interface MutableStrippedSequences {
  osc52: number;
  oscOther: number;
  deviceControl: number;
  kittyGraphics: number;
  unsupportedCsi: number;
  controlCharacters: number;
}

const ESC = "\u001b";
const BEL = "\u0007";
const ST = `${ESC}\\`;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertPositiveInteger(name: string, value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 through ${maximum}`);
  }
}

function resolveLimits(overrides: Partial<VirtualTerminalLimits>): VirtualTerminalLimits {
  for (const key of Object.keys(overrides)) {
    if (!(key in DEFAULT_VIRTUAL_TERMINAL_LIMITS)) throw new TypeError(`unknown virtual terminal limit: ${key}`);
  }
  const limits = { ...DEFAULT_VIRTUAL_TERMINAL_LIMITS, ...overrides };
  for (const key of Object.keys(DEFAULT_VIRTUAL_TERMINAL_LIMITS) as (keyof VirtualTerminalLimits)[]) {
    assertPositiveInteger(key, limits[key], DEFAULT_VIRTUAL_TERMINAL_LIMITS[key]);
  }
  return Object.freeze(limits);
}

function cloneColor(color: VirtualTerminalColor | undefined): VirtualTerminalColor | undefined {
  if (!color) return undefined;
  return color.mode === "indexed"
    ? { mode: "indexed", value: color.value }
    : { mode: "rgb", red: color.red, green: color.green, blue: color.blue };
}

function cloneStyle(style: MutableStyle): VirtualTerminalStyle {
  const result: MutableStyle = {};
  if (style.foreground) result.foreground = cloneColor(style.foreground)!;
  if (style.background) result.background = cloneColor(style.background)!;
  if (style.bold) result.bold = true;
  if (style.dim) result.dim = true;
  if (style.italic) result.italic = true;
  if (style.underline) result.underline = true;
  if (style.inverse) result.inverse = true;
  if (style.strikethrough) result.strikethrough = true;
  if (style.href) result.href = style.href;
  return result;
}

function stylesEqual(left: MutableStyle, right: MutableStyle): boolean {
  const leftFg = left.foreground;
  const rightFg = right.foreground;
  const leftBg = left.background;
  const rightBg = right.background;
  return (
    colorsEqual(leftFg, rightFg) &&
    colorsEqual(leftBg, rightBg) &&
    left.bold === right.bold &&
    left.dim === right.dim &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.inverse === right.inverse &&
    left.strikethrough === right.strikethrough &&
    left.href === right.href
  );
}

function colorsEqual(left: VirtualTerminalColor | undefined, right: VirtualTerminalColor | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.mode !== right.mode) return false;
  if (left.mode === "indexed" && right.mode === "indexed") return left.value === right.value;
  return (
    left.mode === "rgb" &&
    right.mode === "rgb" &&
    left.red === right.red &&
    left.green === right.green &&
    left.blue === right.blue
  );
}

function styleIsEmpty(style: MutableStyle): boolean {
  return Object.keys(style).length === 0;
}

function blankCell(): Cell {
  return { text: " ", width: 1, continuation: false, style: {} };
}

function blankRow(columns: number): Cell[] {
  return Array.from({ length: columns }, blankCell);
}

function safeHyperlink(value: string): string | undefined {
  if (byteLength(value) > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (byteLength(value) <= maximumBytes) return value;
  let result = "";
  for (const character of value) {
    if (byteLength(result) + byteLength(character) > maximumBytes) break;
    result += character;
  }
  return result;
}

/**
 * A bounded, process-independent terminal for Pi TUI rendering.
 *
 * It accepts the same ANSI differential stream as a real terminal, projects the
 * final viewport into styled cells, and emits coalesced row deltas. It never
 * reads stdin, writes stdout, starts a child process, or owns a session file.
 */
export class VirtualTerminal implements Terminal {
  readonly limits: VirtualTerminalLimits;

  private _columns: number;
  private _rows: number;
  private grid: Cell[][];
  private cursorRow = 0;
  private cursorColumn = 0;
  private cursorVisible = false;
  private savedCursor: { row: number; column: number } | undefined;
  private currentStyle: MutableStyle = {};
  private inputHandler: ((data: string) => void) | undefined;
  private resizeHandler: (() => void) | undefined;
  private started = false;
  private pendingEscape = "";
  private dirtyRows = new Set<number>();
  private frameSequence = 0;
  private published = false;
  private dimensionsChanged = false;
  private _title = "";
  private _progress = false;
  private writeCount = 0;
  private acceptedByteCount = 0;
  private readonly framePendingListeners = new Set<() => void>();
  private readonly strippedCounts: MutableStrippedSequences = {
    osc52: 0,
    oscOther: 0,
    deviceControl: 0,
    kittyGraphics: 0,
    unsupportedCsi: 0,
    controlCharacters: 0,
  };

  constructor(
    columns = 80,
    rows = 24,
    limits: Partial<VirtualTerminalLimits> = {},
  ) {
    this.limits = resolveLimits(limits);
    assertPositiveInteger("columns", columns, this.limits.maxColumns);
    assertPositiveInteger("rows", rows, this.limits.maxRows);
    this._columns = columns;
    this._rows = rows;
    this.grid = Array.from({ length: rows }, () => blankRow(columns));
    this.markAllDirty();
  }

  get columns(): number {
    return this._columns;
  }

  get rows(): number {
    return this._rows;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  get title(): string {
    return this._title;
  }

  get progress(): boolean {
    return this._progress;
  }

  subscribeFramePending(listener: () => void): () => void {
    this.framePendingListeners.add(listener);
    return () => this.framePendingListeners.delete(listener);
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    this.started = true;
  }

  stop(): void {
    this.started = false;
    this.inputHandler = undefined;
    this.resizeHandler = undefined;
  }

  async drainInput(): Promise<void> {
    return Promise.resolve();
  }

  sendInput(data: string): void {
    if (!this.started || !this.inputHandler) throw new Error("virtual terminal is not started");
    if (byteLength(data) > this.limits.maxInputBytes) {
      throw new RangeError(`terminal input exceeds ${this.limits.maxInputBytes} bytes`);
    }
    this.inputHandler(data);
  }

  resize(columns: number, rows: number): void {
    assertPositiveInteger("columns", columns, this.limits.maxColumns);
    assertPositiveInteger("rows", rows, this.limits.maxRows);
    if (columns === this._columns && rows === this._rows) return;

    const nextGrid = Array.from({ length: rows }, () => blankRow(columns));
    const copyRows = Math.min(rows, this._rows);
    const copyColumns = Math.min(columns, this._columns);
    for (let row = 0; row < copyRows; row += 1) {
      for (let column = 0; column < copyColumns; column += 1) {
        const cell = this.grid[row]![column]!;
        nextGrid[row]![column] = {
          text: cell.text,
          width: cell.width,
          continuation: cell.continuation,
          style: cloneStyle(cell.style),
        };
      }
    }

    for (const row of nextGrid) {
      for (let column = 0; column < row.length; column += 1) {
        const cell = row[column]!;
        if (cell.continuation && (column === 0 || row[column - 1]!.width !== 2)) row[column] = blankCell();
        if (cell.width === 2 && column + 1 >= row.length) row[column] = blankCell();
      }
    }

    this._columns = columns;
    this._rows = rows;
    this.grid = nextGrid;
    this.cursorRow = Math.min(this.cursorRow, rows - 1);
    this.cursorColumn = Math.min(this.cursorColumn, columns - 1);
    this.dimensionsChanged = true;
    this.markAllDirty();
    if (this.started) this.resizeHandler?.();
    this.notifyFramePending();
  }

  write(data: string): void {
    const bytes = byteLength(data);
    if (bytes > this.limits.maxWriteBytes) {
      throw new RangeError(`terminal write exceeds ${this.limits.maxWriteBytes} bytes`);
    }
    this.writeCount += 1;
    this.acceptedByteCount += bytes;
    this.consume(this.pendingEscape + data);
    if (this.pendingEscape.length === 0) this.notifyFramePending();
  }

  moveBy(lines: number): void {
    if (!Number.isFinite(lines)) return;
    this.cursorRow = Math.max(0, Math.min(this._rows - 1, this.cursorRow + Math.trunc(lines)));
  }

  hideCursor(): void {
    this.cursorVisible = false;
  }

  showCursor(): void {
    this.cursorVisible = true;
  }

  clearLine(): void {
    this.eraseLine(0);
  }

  clearFromCursor(): void {
    this.eraseDisplay(0);
  }

  clearScreen(): void {
    this.eraseDisplay(2);
    this.cursorRow = 0;
    this.cursorColumn = 0;
  }

  setTitle(title: string): void {
    const sanitized = title.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
    this._title = truncateUtf8(sanitized, this.limits.maxTitleBytes);
    this.notifyFramePending();
  }

  setProgress(active: boolean): void {
    this._progress = active;
    this.notifyFramePending();
  }

  takeFrame(options: { readonly force?: boolean } = {}): VirtualTerminalFrame {
    if (this.pendingEscape.length > 0) {
      throw new Error("cannot take a frame with an incomplete terminal escape sequence");
    }
    const full = options.force === true || !this.published || this.dimensionsChanged;
    const rows = full
      ? Array.from({ length: this._rows }, (_, row) => row)
      : [...this.dirtyRows].sort((left, right) => left - right);
    const changedRows = rows.map((row) => this.projectRow(row));
    const frame: VirtualTerminalFrame = {
      sequence: this.frameSequence + 1,
      columns: this._columns,
      rows: this._rows,
      full,
      changedRows,
      cursor: {
        row: Math.max(0, Math.min(this._rows - 1, this.cursorRow)),
        column: Math.max(0, Math.min(this._columns - 1, this.cursorColumn)),
        visible: this.cursorVisible,
      },
      title: this._title,
      progress: this._progress,
      writes: this.writeCount,
      acceptedBytes: this.acceptedByteCount,
      stripped: { ...this.strippedCounts },
    };
    if (byteLength(JSON.stringify(frame)) > this.limits.maxFrameBytes) {
      throw new RangeError(`terminal frame exceeds ${this.limits.maxFrameBytes} bytes`);
    }
    this.frameSequence = frame.sequence;
    this.published = true;
    this.dimensionsChanged = false;
    this.dirtyRows.clear();
    return frame;
  }

  private consume(data: string): void {
    this.pendingEscape = "";
    let index = 0;
    while (index < data.length) {
      const character = data[index]!;
      if (character === ESC) {
        const result = this.consumeEscape(data, index);
        if (result === undefined) {
          const pending = data.slice(index);
          if (byteLength(pending) > this.limits.maxEscapeBytes) {
            throw new RangeError(`terminal escape sequence exceeds ${this.limits.maxEscapeBytes} bytes`);
          }
          this.pendingEscape = pending;
          return;
        }
        index = result;
        continue;
      }
      const code = character.codePointAt(0)!;
      if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
        this.consumeControl(character);
        index += character.length;
        continue;
      }
      let end = index;
      while (end < data.length) {
        const next = data.codePointAt(end)!;
        if (next === 0x1b || next < 0x20 || next === 0x7f || (next >= 0x80 && next <= 0x9f)) break;
        end += next > 0xffff ? 2 : 1;
      }
      const printable = data.slice(index, end);
      for (const segment of graphemeSegmenter.segment(printable)) this.writeGrapheme(segment.segment);
      index = end;
    }
  }

  private consumeEscape(data: string, index: number): number | undefined {
    if (index + 1 >= data.length) return undefined;
    const introducer = data[index + 1]!;
    if (introducer === "[") {
      for (let cursor = index + 2; cursor < data.length; cursor += 1) {
        const code = data.charCodeAt(cursor);
        if (code >= 0x40 && code <= 0x7e) {
          this.assertEscapeBound(data.slice(index, cursor + 1));
          this.consumeCsi(data.slice(index + 2, cursor), data[cursor]!);
          return cursor + 1;
        }
      }
      return undefined;
    }
    if (introducer === "]") {
      const bell = data.indexOf(BEL, index + 2);
      const terminator = data.indexOf(ST, index + 2);
      if (bell === -1 && terminator === -1) return undefined;
      const end = bell !== -1 && (terminator === -1 || bell < terminator) ? bell : terminator;
      this.assertEscapeBound(data.slice(index, end + (end === terminator ? ST.length : BEL.length)));
      this.consumeOsc(data.slice(index + 2, end));
      return end + (end === terminator ? ST.length : BEL.length);
    }
    if (introducer === "P" || introducer === "_" || introducer === "^" || introducer === "X") {
      const terminator = data.indexOf(ST, index + 2);
      if (terminator === -1) return undefined;
      this.assertEscapeBound(data.slice(index, terminator + ST.length));
      const payload = data.slice(index + 2, terminator);
      if (introducer === "_" && payload.startsWith("G")) this.strippedCounts.kittyGraphics += 1;
      else this.strippedCounts.deviceControl += 1;
      return terminator + ST.length;
    }
    const introducerCode = introducer.charCodeAt(0);
    if (introducerCode >= 0x20 && introducerCode <= 0x2f) {
      for (let cursor = index + 2; cursor < data.length; cursor += 1) {
        const code = data.charCodeAt(cursor);
        if (code >= 0x30 && code <= 0x7e) {
          this.assertEscapeBound(data.slice(index, cursor + 1));
          this.strippedCounts.deviceControl += 1;
          return cursor + 1;
        }
        if (code < 0x20 || code > 0x2f) {
          this.strippedCounts.deviceControl += 1;
          return cursor;
        }
      }
      return undefined;
    }

    switch (introducer) {
      case "7":
        this.savedCursor = { row: this.cursorRow, column: this.cursorColumn };
        break;
      case "8":
        if (this.savedCursor) {
          this.cursorRow = this.savedCursor.row;
          this.cursorColumn = this.savedCursor.column;
        }
        break;
      case "D":
        this.lineFeed();
        break;
      case "E":
        this.cursorColumn = 0;
        this.lineFeed();
        break;
      case "M":
        this.reverseIndex();
        break;
      case "c":
        this.reset();
        break;
      default:
        this.strippedCounts.deviceControl += 1;
        break;
    }
    return index + 2;
  }

  private assertEscapeBound(sequence: string): void {
    if (byteLength(sequence) > this.limits.maxEscapeBytes) {
      throw new RangeError(`terminal escape sequence exceeds ${this.limits.maxEscapeBytes} bytes`);
    }
  }

  private consumeControl(character: string): void {
    switch (character) {
      case "\r":
        this.cursorColumn = 0;
        break;
      case "\n":
      case "\u000b":
      case "\u000c":
        this.lineFeed();
        break;
      case "\b":
        this.cursorColumn = Math.max(0, this.cursorColumn - 1);
        break;
      case "\t":
        this.cursorColumn = Math.min(this._columns - 1, (Math.floor(this.cursorColumn / 8) + 1) * 8);
        break;
      default:
        this.strippedCounts.controlCharacters += 1;
        break;
    }
  }

  private consumeOsc(payload: string): void {
    const separator = payload.indexOf(";");
    const command = separator === -1 ? payload : payload.slice(0, separator);
    const value = separator === -1 ? "" : payload.slice(separator + 1);
    if (command === "52") {
      this.strippedCounts.osc52 += 1;
      return;
    }
    if (command === "8") {
      const urlSeparator = value.indexOf(";");
      const url = urlSeparator === -1 ? "" : value.slice(urlSeparator + 1);
      if (url === "") {
        delete this.currentStyle.href;
        return;
      }
      const safe = safeHyperlink(url);
      if (safe) this.currentStyle.href = safe;
      else this.strippedCounts.oscOther += 1;
      return;
    }
    this.strippedCounts.oscOther += 1;
  }

  private consumeCsi(parametersText: string, final: string): void {
    const privatePrefix = parametersText.startsWith("?") ? "?" : "";
    const body = privatePrefix ? parametersText.slice(1) : parametersText;
    const parameters = body.length === 0
      ? []
      : body.split(";").map((value) => {
          const parsed = Number.parseInt(value, 10);
          return Number.isFinite(parsed) ? parsed : 0;
        });
    const first = parameters[0] ?? 0;
    const distance = Math.max(1, first || 1);

    if (privatePrefix === "?" && (final === "h" || final === "l")) {
      if (first === 25) this.cursorVisible = final === "h";
      else if (first !== 2026 && first !== 2004 && first !== 2031) this.strippedCounts.unsupportedCsi += 1;
      return;
    }
    if (privatePrefix) {
      this.strippedCounts.unsupportedCsi += 1;
      return;
    }

    switch (final) {
      case "A":
        this.cursorRow = Math.max(0, this.cursorRow - distance);
        break;
      case "B":
        this.cursorRow = Math.min(this._rows - 1, this.cursorRow + distance);
        break;
      case "C":
        this.cursorColumn = Math.min(this._columns - 1, this.cursorColumn + distance);
        break;
      case "D":
        this.cursorColumn = Math.max(0, this.cursorColumn - distance);
        break;
      case "E":
        this.cursorRow = Math.min(this._rows - 1, this.cursorRow + distance);
        this.cursorColumn = 0;
        break;
      case "F":
        this.cursorRow = Math.max(0, this.cursorRow - distance);
        this.cursorColumn = 0;
        break;
      case "G":
      case "`":
        this.cursorColumn = Math.max(0, Math.min(this._columns - 1, distance - 1));
        break;
      case "d":
        this.cursorRow = Math.max(0, Math.min(this._rows - 1, distance - 1));
        break;
      case "H":
      case "f":
        this.cursorRow = Math.max(0, Math.min(this._rows - 1, (parameters[0] || 1) - 1));
        this.cursorColumn = Math.max(0, Math.min(this._columns - 1, (parameters[1] || 1) - 1));
        break;
      case "J":
        this.eraseDisplay(first);
        break;
      case "K":
        this.eraseLine(first);
        break;
      case "m":
        this.consumeSgr(parameters);
        break;
      case "s":
        this.savedCursor = { row: this.cursorRow, column: this.cursorColumn };
        break;
      case "u":
        if (this.savedCursor) {
          this.cursorRow = this.savedCursor.row;
          this.cursorColumn = this.savedCursor.column;
        }
        break;
      case "S":
        this.scrollUp(distance);
        break;
      case "T":
        this.scrollDown(distance);
        break;
      case "n":
      case "t":
      case "h":
      case "l":
        this.strippedCounts.unsupportedCsi += 1;
        break;
      default:
        this.strippedCounts.unsupportedCsi += 1;
        break;
    }
  }

  private consumeSgr(parameters: number[]): void {
    const values = parameters.length === 0 ? [0] : parameters;
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index]!;
      if (value === 0) {
        const href = this.currentStyle.href;
        this.currentStyle = href === undefined ? {} : { href };
      }
      else if (value === 1) this.currentStyle.bold = true;
      else if (value === 2) this.currentStyle.dim = true;
      else if (value === 3) this.currentStyle.italic = true;
      else if (value === 4) this.currentStyle.underline = true;
      else if (value === 7) this.currentStyle.inverse = true;
      else if (value === 9) this.currentStyle.strikethrough = true;
      else if (value === 22) {
        delete this.currentStyle.bold;
        delete this.currentStyle.dim;
      } else if (value === 23) delete this.currentStyle.italic;
      else if (value === 24) delete this.currentStyle.underline;
      else if (value === 27) delete this.currentStyle.inverse;
      else if (value === 29) delete this.currentStyle.strikethrough;
      else if (value >= 30 && value <= 37) this.currentStyle.foreground = { mode: "indexed", value: value - 30 };
      else if (value >= 40 && value <= 47) this.currentStyle.background = { mode: "indexed", value: value - 40 };
      else if (value >= 90 && value <= 97) this.currentStyle.foreground = { mode: "indexed", value: value - 90 + 8 };
      else if (value >= 100 && value <= 107) this.currentStyle.background = { mode: "indexed", value: value - 100 + 8 };
      else if (value === 39) delete this.currentStyle.foreground;
      else if (value === 49) delete this.currentStyle.background;
      else if (value === 38 || value === 48) {
        const target = value === 38 ? "foreground" : "background";
        const mode = values[index + 1];
        if (mode === 5 && values[index + 2] !== undefined) {
          this.currentStyle[target] = { mode: "indexed", value: Math.max(0, Math.min(255, values[index + 2]!)) };
          index += 2;
        } else if (mode === 2 && values[index + 2] !== undefined && values[index + 3] !== undefined && values[index + 4] !== undefined) {
          this.currentStyle[target] = {
            mode: "rgb",
            red: Math.max(0, Math.min(255, values[index + 2]!)),
            green: Math.max(0, Math.min(255, values[index + 3]!)),
            blue: Math.max(0, Math.min(255, values[index + 4]!)),
          };
          index += 4;
        }
      }
    }
  }

  private writeGrapheme(grapheme: string): void {
    const width = visibleWidth(grapheme);
    if (width <= 0) {
      const previousColumn = Math.min(this._columns - 1, this.cursorColumn - 1);
      if (previousColumn >= 0) {
        const previous = this.grid[this.cursorRow]![previousColumn]!;
        const lead = previous.continuation && previousColumn > 0
          ? this.grid[this.cursorRow]![previousColumn - 1]!
          : previous;
        lead.text += grapheme;
        this.dirtyRows.add(this.cursorRow);
      }
      return;
    }
    const cellWidth: 1 | 2 = width > 1 ? 2 : 1;
    if (this.cursorColumn >= this._columns || (cellWidth === 2 && this.cursorColumn === this._columns - 1)) {
      this.cursorColumn = 0;
      this.lineFeed();
    }

    this.eraseCellForWrite(this.cursorRow, this.cursorColumn);
    const row = this.grid[this.cursorRow]!;
    row[this.cursorColumn] = {
      text: grapheme,
      width: cellWidth,
      continuation: false,
      style: cloneStyle(this.currentStyle),
    };
    if (cellWidth === 2 && this.cursorColumn + 1 < this._columns) {
      this.eraseCellForWrite(this.cursorRow, this.cursorColumn + 1);
      row[this.cursorColumn + 1] = {
        text: "",
        width: 1,
        continuation: true,
        style: cloneStyle(this.currentStyle),
      };
    }
    this.dirtyRows.add(this.cursorRow);
    this.cursorColumn += cellWidth;
  }

  private eraseCellForWrite(rowIndex: number, column: number): void {
    const row = this.grid[rowIndex]!;
    const existing = row[column]!;
    if (existing.continuation && column > 0) row[column - 1] = blankCell();
    if (!existing.continuation && existing.width === 2 && column + 1 < this._columns) row[column + 1] = blankCell();
    row[column] = blankCell();
  }

  private lineFeed(): void {
    if (this.cursorRow >= this._rows - 1) this.scrollUp(1);
    else this.cursorRow += 1;
  }

  private reverseIndex(): void {
    if (this.cursorRow <= 0) this.scrollDown(1);
    else this.cursorRow -= 1;
  }

  private scrollUp(count: number): void {
    const bounded = Math.min(this._rows, Math.max(0, count));
    if (bounded === 0) return;
    this.grid.splice(0, bounded);
    for (let index = 0; index < bounded; index += 1) this.grid.push(blankRow(this._columns));
    this.markAllDirty();
  }

  private scrollDown(count: number): void {
    const bounded = Math.min(this._rows, Math.max(0, count));
    if (bounded === 0) return;
    this.grid.splice(this._rows - bounded, bounded);
    for (let index = 0; index < bounded; index += 1) this.grid.unshift(blankRow(this._columns));
    this.markAllDirty();
  }

  private eraseLine(mode: number): void {
    const column = Math.max(0, Math.min(this._columns - 1, this.cursorColumn));
    const start = mode === 1 || mode === 2 ? 0 : column;
    const end = mode === 0 ? this._columns - 1 : mode === 1 ? column : this._columns - 1;
    for (let index = start; index <= end; index += 1) this.eraseCellForWrite(this.cursorRow, index);
    this.dirtyRows.add(this.cursorRow);
  }

  private eraseDisplay(mode: number): void {
    const column = Math.max(0, Math.min(this._columns - 1, this.cursorColumn));
    if (mode === 3) return; // Scrollback is intentionally not retained.
    if (mode === 2) {
      this.grid = Array.from({ length: this._rows }, () => blankRow(this._columns));
      this.markAllDirty();
      return;
    }
    if (mode === 0) {
      for (let index = column; index < this._columns; index += 1) this.eraseCellForWrite(this.cursorRow, index);
      for (let row = this.cursorRow + 1; row < this._rows; row += 1) this.grid[row] = blankRow(this._columns);
      for (let row = this.cursorRow; row < this._rows; row += 1) this.dirtyRows.add(row);
      return;
    }
    if (mode === 1) {
      for (let row = 0; row < this.cursorRow; row += 1) this.grid[row] = blankRow(this._columns);
      for (let index = 0; index <= column; index += 1) this.eraseCellForWrite(this.cursorRow, index);
      for (let row = 0; row <= this.cursorRow; row += 1) this.dirtyRows.add(row);
    }
  }

  private reset(): void {
    this.currentStyle = {};
    this.savedCursor = undefined;
    this.cursorRow = 0;
    this.cursorColumn = 0;
    this.cursorVisible = false;
    this.eraseDisplay(2);
  }

  private projectRow(rowIndex: number): VirtualTerminalRowDelta {
    const row = this.grid[rowIndex]!;
    let last = -1;
    for (let column = 0; column < row.length; column += 1) {
      const cell = row[column]!;
      if ((!cell.continuation && cell.text !== " ") || !styleIsEmpty(cell.style)) last = column;
    }
    if (last === -1) return { row: rowIndex, text: "", runs: [] };

    const runs: VirtualTerminalRun[] = [];
    let plainText = "";
    let runText = "";
    let runColumns = 0;
    let runStyle: MutableStyle | undefined;
    const flush = (): void => {
      if (!runStyle || runColumns === 0) return;
      runs.push({ text: runText, columns: runColumns, style: cloneStyle(runStyle) });
      runText = "";
      runColumns = 0;
    };

    for (let column = 0; column <= last; column += 1) {
      const cell = row[column]!;
      if (cell.continuation) continue;
      plainText += cell.text;
      if (!runStyle || !stylesEqual(runStyle, cell.style)) {
        flush();
        runStyle = cell.style;
      }
      runText += cell.text;
      runColumns += cell.width;
    }
    flush();
    return { row: rowIndex, text: plainText, runs };
  }

  private notifyFramePending(): void {
    for (const listener of this.framePendingListeners) listener();
  }

  private markAllDirty(): void {
    for (let row = 0; row < this._rows; row += 1) this.dirtyRows.add(row);
  }
}
