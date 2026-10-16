import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { puff } from '@/lib/api';

/**
 * A real terminal. It shows what the program (an agent's own CLI, or a shell) prints and sends what the person
 * types straight back to it, so Claude Code, Codex and OpenCode look and behave exactly as in any terminal.
 * A terminal keeps running when this view goes away; opening it again catches up with what it printed.
 */
export function TerminalView({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", "Cascadia Mono", Consolas, ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: '#0a0a0a',
        foreground: '#e6e6e6',
        cursor: '#e6e6e6',
        selectionBackground: '#3a3a5c',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    // Output that arrives while we catch up is held, then written only if the catch-up did not include it
    let caughtUp = false;
    let upTo = 0;
    const held: { data: string; end: number }[] = [];
    const off = puff.onEvent((e) => {
      if (e.type === 'terminal' && e.id === id) {
        if (!caughtUp) held.push({ data: e.data, end: e.end });
        else term.write(e.data);
      } else if (e.type === 'terminal:exit' && e.id === id) {
        term.write(
          `\r\n\x1b[2m[the program ended${e.code ? `, exit code ${e.code}` : ''}]\x1b[0m\r\n`,
        );
      }
    });
    void puff.terminalAttach(id).then(({ data, end }) => {
      if (data) term.write(data);
      upTo = end;
      for (const h of held) if (h.end > upTo) term.write(h.data);
      caughtUp = true;
    });

    const sync = () => {
      try {
        fit.fit();
        void puff.terminalResize(id, term.cols, term.rows);
      } catch {
        // the view is not visible yet
      }
    };
    sync();
    const input = term.onData((data) => void puff.terminalWrite(id, data));
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    term.focus();

    return () => {
      off();
      input.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, [id]);

  return <div ref={host} className="h-full w-full overflow-hidden rounded-xl bg-[#0a0a0a] p-2" />;
}
