/** QR を表示するシート（1枚〜複数枚・セクション分け） */
import { el, openSheet } from './dom.js';
import { createQrBlock } from '../qr/gen.js';

/**
 * @param {{title:string, description?:string, qrs?:string[], sections?:Array<{heading?:string,note?:string,labels?:string[],qrs:string[]}>, labels?:string[], note?:string, actions?:any[], onClose?:Function}} options
 * sections を渡すと、見出し付きで区切って並べる（リカバリーQRのように種類を混ぜるとき）。
 */
export function showQrSheet({ title, description = '', qrs = [], sections = null, labels = [], note = '', actions = [], onClose = null }) {
  const groups = (Array.isArray(sections) && sections.length ? sections : [{ qrs }]).map((section) => ({
    heading: section.heading ?? '',
    note: section.note ?? '',
    labels: section.labels ?? [],
    qrs: section.qrs ?? [],
  })).filter((group) => group.qrs.length);
  const total = groups.reduce((sum, group) => sum + group.qrs.length, 0);

  if (!total) {
    return openSheet({
      title,
      content: el('p', { class: 'muted', text: '表示するQRコードがありません' }),
      actions,
      onClose,
    });
  }

  const content = el('div', { class: 'qr-sheet' });
  if (total > 1) {
    content.append(
      el('p', {
        class: 'qr-sheet__hint',
        text: `QRコードが ${total} 枚あります。上から順に読み取ってください（読み取り済みのQRは無視されます）。`,
      })
    );
  }
  let index = 0;
  for (const group of groups) {
    if (group.heading) content.append(el('h3', { class: 'qr-sheet__section', text: group.heading }));
    if (group.note) content.append(el('p', { class: 'qr-sheet__section-note muted small', text: group.note }));
    group.qrs.forEach((text, groupIndex) => {
      index += 1;
      content.append(createQrBlock(text, {
        label: group.labels[groupIndex] ?? labels[index - 1] ?? '',
        index,
        total,
      }));
    });
  }
  if (note) content.append(el('p', { class: 'qr-sheet__note muted', text: note }));

  return openSheet({ title, description, content, size: 'wide', actions, onClose });
}
