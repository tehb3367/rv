import { TextAttributes } from '@opentui/core';
import { decodePasteBytes } from '@opentui/core';
import { useKeyboard, useOnResize, usePaste, useTerminalDimensions } from '@opentui/react';
import { useEffect, useReducer } from 'react';
import type { KeyAction } from '../core/config.ts';
import { UNSTACKED_ID } from '../core/types.ts';
import { Controller, SUBMIT_CHOICES } from './controller.ts';
import { fitCells, renderLine, roleColor, segCells, type Cell } from './render.ts';
import { riskRole, type Row } from './rows.ts';
import { fit, truncate, width, wrap } from './text.ts';

function Line({ cells, onMouseDown }: { cells: Cell[]; onMouseDown?: () => void }) {
  return (
    <text height={1} wrapMode="none" onMouseDown={onMouseDown}>
      {cells.map((c, i) => (
        <span key={i} fg={c.fg} bg={c.bg} attributes={c.bold ? TextAttributes.BOLD : 0}>
          {c.text}
        </span>
      ))}
    </text>
  );
}

function withCursor(cells: Cell[], on: boolean, focus: string): Cell[] {
  if (!on || !cells.length) return cells;
  const first = cells[0]!;
  const rest = [...first.text].slice(1).join('');
  return [{ text: '▌', fg: focus, bg: first.bg }, ...(rest ? [{ ...first, text: rest }] : []), ...cells.slice(1)];
}

function rowCells(ctl: Controller, row: Row, cursor: boolean): Cell[] {
  const p = ctl.palette;
  const w = ctl.paneWidth;
  if (row.kind === 'line') {
    const h = ctl.session.hunkMap.get(row.hunkId)!;
    return renderLine({
      line: h.lines[row.lineIndex]!,
      styled: ctl.styledFor(h, row.lineIndex),
      start: row.start,
      end: row.end,
      cont: row.cont,
      numWidth: ctl.rows.numWidth,
      paneWidth: w,
      wrap: ctl.wrap,
      cursor,
      palette: p,
    });
  }
  return withCursor(fitCells(segCells(row.segs, p, p.bg), w, p.bg), cursor, p.focus);
}

function Header({ ctl }: { ctl: Controller }) {
  const p = ctl.palette;
  const s = ctl.session;
  const title = s.rec.hasPlan ? s.view.title : 'Unstacked';
  const range = `${s.src.baseLabel}..${s.src.headLabel}`;
  const pr = s.src.prNumber !== undefined ? ` · PR #${s.src.prNumber}` : '';
  const prog = ctl.progress;
  const right = `${prog.reviewed}/${prog.total} hunks · agent ${s.agentWaiting ? 'waiting' : 'idle'} `;
  const leftRoom = Math.max(10, ctl.width - width(right) - 1);
  const left = truncate(` rv · ${title} · ${range}${pr}`, leftRoom);
  const gap = Math.max(1, ctl.width - width(left) - width(right));
  return (
    <Line
      cells={[
        { text: ' rv', fg: p.focus, bg: p.bg, bold: true },
        { text: left.slice(3), fg: p.fg, bg: p.bg },
        { text: ' '.repeat(gap), bg: p.bg },
        { text: `${prog.reviewed}/${prog.total} hunks · `, fg: p.muted, bg: p.bg },
        { text: `agent ${s.agentWaiting ? 'waiting' : 'idle'} `, fg: s.agentWaiting ? p.askBorder : p.muted, bg: p.bg, bold: s.agentWaiting },
      ]}
    />
  );
}

function Banner({ ctl }: { ctl: Controller }) {
  const p = ctl.palette;
  const n = ctl.session.rec.newHunks.length;
  const text = ` ⚠ plan is stale, ${n} new hunk${n === 1 ? '' : 's'} — they are in the Unplaced layer; ask the agent to re-plan`;
  return <Line cells={[{ text: fit(text, ctl.width), fg: p.riskMed, bg: p.bg, bold: true }]} />;
}

function Footer({ ctl }: { ctl: Controller }) {
  const p = ctl.palette;
  if (ctl.flash) {
    return <Line cells={[{ text: fit(' ' + ctl.flash.text, ctl.width), fg: roleColor(ctl.flash.role, p), bg: p.bg }]} />;
  }
  const k = ctl.deps.config.keys;
  const show = (a: KeyAction) => (k[a] === 'space' ? 'space' : k[a]);
  const hint = ` ${show('reviewed')} reviewed · ${show('comment')} comment · ${show('ask')} ask agent · ${show('send')} send (${ctl.draftAskCount}) · ${show('nextLayer')}/${show('prevLayer')} layer · ${show('nextHunk')}/${show('prevHunk')} hunk · ${show('help')} help`;
  return <Line cells={[{ text: fit(hint, ctl.width), fg: p.muted, bg: p.bg }]} />;
}

function Sidebar({ ctl, overlay }: { ctl: Controller; overlay: boolean }) {
  const p = ctl.palette;
  const w = ctl.sideWidth;
  const inner = w - 2;
  const focused = ctl.focus === 'layers';
  const lines: { cells: Cell[]; layer?: number }[] = [];
  let lastGroup: string | undefined = undefined;
  const bg = p.sidebarBg;
  ctl.layers.forEach((l, i) => {
    if (l.group !== lastGroup && l.group) lines.push({ cells: [{ text: fit(' ' + l.group, inner), fg: p.muted, bg, bold: true }] });
    lastGroup = l.group;
    const { done, total } = ctl.layerProgress(l);
    const current = i === ctl.layerIdx;
    const selected = focused && i === ctl.sideSel;
    const mark = done === total && total > 0 ? '✓' : current ? '▸' : ' ';
    const risk = l.id === UNSTACKED_ID ? '' : l.risk;
    const count = `${done}/${total}`;
    const label = l.id === UNSTACKED_ID ? 'Unstacked' : `${l.id === 'Unplaced' ? '' : l.id + ' '}${l.title}`;
    const tail = ` ${risk.padEnd(4)} ${count}`;
    const head = `${l.group ? ' ' : ''}${mark} `;
    const room = Math.max(4, inner - width(head) - width(tail));
    const rowBg = selected ? p.focus : current ? (p.bg ?? bg) : bg;
    lines.push({
      layer: i,
      cells: fitCells(
        [
          { text: head, fg: done === total && total > 0 ? p.riskLow : p.focus, bg: rowBg },
          { text: fit(label, room), fg: p.fg, bg: rowBg, bold: current },
          { text: ` ${risk.padEnd(4)}`, fg: roleColor(riskRole(l.risk), p), bg: rowBg },
          { text: ` ${count}`, fg: p.muted, bg: rowBg },
        ],
        inner,
        rowBg,
      ),
    });
  });
  const h = overlay ? ctl.height - 3 : ctl.paneHeight;
  const start = Math.max(0, Math.min(lines.findIndex((x) => x.layer === ctl.sideSel) - h + 2, Math.max(0, lines.length - h)));
  const visible = lines.slice(start, start + h);
  return (
    <box
      width={w}
      height={overlay ? ctl.height - 1 : undefined}
      border
      borderColor={focused ? p.focus : p.muted}
      title=" Layers "
      backgroundColor={bg}
      flexDirection="column"
      {...(overlay ? { position: 'absolute' as const, left: 0, top: 1, zIndex: 10 } : {})}
      onMouseScroll={(e) => e.scroll && ctl.wheel('layers', e.scroll.direction === 'down' ? 'down' : 'up')}
    >
      {visible.map((ln, i) => (
        <Line
          key={i}
          cells={ln.cells}
          onMouseDown={
            ln.layer !== undefined
              ? () => {
                  ctl.openLayer(ln.layer!);
                  if (ctl.sideOverlay) ctl.sideOverlay = false;
                  ctl.notify();
                }
              : undefined
          }
        />
      ))}
    </box>
  );
}

function MainPane({ ctl }: { ctl: Controller }) {
  const p = ctl.palette;
  const l = ctl.layer;
  const rows = ctl.rows.rows;
  const h = ctl.paneHeight;
  const visible = rows.slice(ctl.scroll, ctl.scroll + h);
  const title =
    l.id === UNSTACKED_ID ? ' Unstacked ' : ` ${l.id === 'Unplaced' ? '' : l.id + ' · '}${truncate(l.title, Math.max(10, ctl.paneWidth - 20))}  risk: ${l.risk} `;
  const filler = Math.max(0, h - visible.length);
  return (
    <box
      flexGrow={1}
      border
      borderColor={ctl.focus === 'main' ? p.focus : p.muted}
      title={title}
      backgroundColor={p.bg}
      flexDirection="column"
      onMouseScroll={(e) => e.scroll && ctl.wheel('main', e.scroll.direction === 'down' ? 'down' : 'up')}
    >
      {visible.map((r, i) => (
        <Line key={r.key} cells={rowCells(ctl, r, ctl.scroll + i === ctl.cursor && ctl.focus === 'main')} />
      ))}
      {Array.from({ length: filler }, (_, i) => (
        <Line key={`pad${i}`} cells={[{ text: ' '.repeat(ctl.paneWidth), bg: p.bg }]} />
      ))}
    </box>
  );
}

function EditorBox({ ctl }: { ctl: Controller }) {
  const p = ctl.palette;
  const ed = ctl.editor!;
  const kind = ed.mode === 'edit' ? 'edit comment' : ed.mode === 'ask' ? 'ask agent' : 'review comment';
  const anchor = ed.line ? ` · line ${ed.line.side}:${ed.line.number}` : ' · hunk';
  const title = ` ${kind}${anchor} · Enter save · Ctrl-j newline · Ctrl-e $EDITOR · Esc cancel `;
  const inner = ctl.width - 2;
  const before = ed.text.slice(0, ed.pos);
  const at = ed.text.slice(ed.pos, ed.pos + 1);
  const after = ed.text.slice(ed.pos + 1);
  // Render with a block cursor by splitting into lines.
  const marked = before + '\u0000' + (at && at !== '\n' ? at : ' ') + '\u0001' + (at === '\n' ? '\n' : '') + after;
  const lines = marked.split('\n').flatMap((l) => wrap(l, inner - 1));
  const maxLines = ctl.editorHeight - 2;
  const curLine = Math.max(0, lines.findIndex((l) => l.includes('\u0000')));
  const start = Math.max(0, Math.min(curLine - maxLines + 1, lines.length - maxLines));
  const shown = lines.slice(start, start + maxLines);
  const color = ed.mode === 'ask' ? p.askBorder : p.reviewBorder;
  return (
    <box height={ctl.editorHeight} border borderColor={color} title={title} backgroundColor={p.bg} flexDirection="column">
      {shown.map((l, i) => {
        const a = l.indexOf('\u0000');
        const b = l.indexOf('\u0001');
        const cells: Cell[] =
          a >= 0 && b > a
            ? [
                { text: ' ' + l.slice(0, a), fg: p.fg, bg: p.bg },
                { text: l.slice(a + 1, b), fg: p.bg ?? '#000000', bg: p.fg ?? '#ffffff' },
                { text: l.slice(b + 1), fg: p.fg, bg: p.bg },
              ]
            : [{ text: ' ' + l.replace(/[\u0000\u0001]/g, ''), fg: p.fg, bg: p.bg }];
        return <Line key={i} cells={fitCells(cells, inner, p.bg)} />;
      })}
    </box>
  );
}

const HELP: [KeyAction | string, string][] = [
  ['down', 'move cursor down (also ↓)'],
  ['up', 'move cursor up (also ↑)'],
  ['halfDown', 'half page down'],
  ['halfUp', 'half page up'],
  ['top', 'top of layer'],
  ['bottom', 'bottom of layer'],
  ['nextHunk', 'next hunk'],
  ['prevHunk', 'previous hunk'],
  ['nextLayer', 'next layer'],
  ['prevLayer', 'previous layer'],
  ['nextUnreviewed', 'next unreviewed hunk in any layer'],
  ['focus', 'switch pane focus; Enter opens a layer'],
  ['reviewed', 'mark hunk reviewed and move on (again to unmark)'],
  ['layerReviewed', 'mark the whole layer reviewed'],
  ['expand', 'expand or collapse the hunk'],
  ['comment', 'review comment on the cursor line'],
  ['ask', 'ask the agent about the cursor line'],
  ['edit', 'edit your comment'],
  ['delete', 'delete a draft'],
  ['resolve', 'resolve a thread'],
  ['send', 'send all draft asks to the agent'],
  ['export', 'export markdown (clipboard + <git dir>/rv/export.md)'],
  ['submit', 'submit the review to GitHub'],
  ['reload', 'reload the diff'],
  ['wrap', 'toggle line wrap'],
  ['sidebar', 'toggle the layers pane'],
  ['help', 'this help'],
  ['quit', 'quit'],
];

function CenterBox({ ctl, title, lines, color }: { ctl: Controller; title: string; lines: Cell[][]; color: string }) {
  const p = ctl.palette;
  const w = Math.min(ctl.width - 4, Math.max(40, ...lines.map((l) => l.reduce((a, c) => a + width(c.text), 0) + 4)));
  const h = Math.min(ctl.height - 2, lines.length + 2);
  return (
    <box
      position="absolute"
      left={Math.max(0, Math.floor((ctl.width - w) / 2))}
      top={Math.max(0, Math.floor((ctl.height - h) / 2))}
      width={w}
      height={h}
      zIndex={20}
      border
      borderColor={color}
      title={title}
      backgroundColor={p.sidebarBg ?? p.bg}
      flexDirection="column"
    >
      {lines.slice(0, h - 2).map((l, i) => (
        <Line key={i} cells={fitCells(l, w - 2, p.sidebarBg ?? p.bg)} />
      ))}
    </box>
  );
}

function Overlay({ ctl }: { ctl: Controller }) {
  const p = ctl.palette;
  const o = ctl.overlay;
  if (!o) return null;
  const bg = p.sidebarBg ?? p.bg;
  if (o.type === 'help') {
    const keys = ctl.deps.config.keys as Record<string, string>;
    const lines = HELP.map(([a, d]) => [
      { text: ` ${(keys[a] ?? a).padEnd(8)}`, fg: p.focus, bg, bold: true },
      { text: d, fg: p.fg, bg },
    ]);
    lines.push([{ text: ' mouse: wheel scrolls, click a layer to open it · any key closes', fg: p.muted, bg }]);
    return <CenterBox ctl={ctl} title=" Help " lines={lines} color={p.focus} />;
  }
  if (o.type === 'picker') {
    const lines = SUBMIT_CHOICES.map((c, i) => [
      { text: i === o.sel ? ' ▸ ' : '   ', fg: p.focus, bg },
      { text: c.label, fg: p.fg, bg, bold: i === o.sel },
    ]);
    lines.push([{ text: ' j/k choose · Enter confirm · Esc cancel', fg: p.muted, bg }]);
    return <CenterBox ctl={ctl} title=" Submit review " lines={lines} color={p.focus} />;
  }
  return <CenterBox ctl={ctl} title=" Confirm " lines={[[{ text: ' ' + o.message, fg: p.fg, bg }]]} color={p.riskMed} />;
}

export function App({ ctl }: { ctl: Controller }) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const dims = useTerminalDimensions();
  ctl.resize(dims.width, dims.height);
  useEffect(() => ctl.subscribe(force), [ctl]);
  useOnResize((w, h) => ctl.resize(w, h));
  useKeyboard((k) => ctl.handleKey(k));
  usePaste((e) => ctl.editor && ctl.insertText(decodePasteBytes(e.bytes)));
  const p = ctl.palette;
  return (
    <box width={ctl.width} height={ctl.height} flexDirection="column" backgroundColor={p.bg}>
      <Header ctl={ctl} />
      {ctl.bannerHeight > 0 && <Banner ctl={ctl} />}
      <box flexDirection="row" flexGrow={1}>
        {ctl.sidebarDocked && <Sidebar ctl={ctl} overlay={false} />}
        <MainPane ctl={ctl} />
      </box>
      {ctl.editor && <EditorBox ctl={ctl} />}
      <Footer ctl={ctl} />
      {ctl.sideOverlay && !ctl.sidebarDocked && <Sidebar ctl={ctl} overlay />}
      <Overlay ctl={ctl} />
    </box>
  );
}
