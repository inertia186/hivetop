import xterm from "@xterm/headless";

// Exercise real VT parsing, including cursor movement, erase commands, and colors.
export class TerminalScreen {
  constructor(columns = process.stdout.columns || 100, rows = process.stdout.rows || 30) {
    this.terminal = new xterm.Terminal({ cols: columns, rows, convertEol: true, allowProposedApi: true, scrollback: 0 });
  }

  write(chunk) { this.terminal.write(String(chunk)); }
  resize(columns, rows) { this.terminal.resize(columns, rows); }
  dispose() { this.terminal.dispose(); }
  flush() { return new Promise(resolve => this.terminal.write("", resolve)); }

  async text() {
    await this.flush();
    const { active } = this.terminal.buffer;
    return Array.from({ length: this.terminal.rows }, (_, row) => active.getLine(active.viewportY + row).translateToString()).join("\n");
  }

  async cells() {
    await this.flush();
    const { active } = this.terminal.buffer;
    return Array.from({ length: this.terminal.rows }, (_, row) => {
      const line = active.getLine(active.viewportY + row);
      return Array.from({ length: this.terminal.cols }, (_, column) => {
        const cell = line.getCell(column);
        return [cell.getChars() || " ", cell.getWidth(), cell.getFgColorMode(), cell.getFgColor(),
          cell.getBgColorMode(), cell.getBgColor(), cell.isBold(), cell.isDim(), cell.isItalic(),
          cell.isUnderline(), cell.isBlink(), cell.isInverse(), cell.isInvisible(), cell.isStrikethrough()];
      });
    });
  }
}
