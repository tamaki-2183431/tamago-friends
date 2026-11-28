/**
 * 親画面（parent.html）。4桁PIN での解錠後のみ中身を描画する。
 * 点数入力・訂正・監査・ごほうび承認・バックアップをここから行う。
 */
import * as store from '../store/parent.js';
import { summarize } from '../game/points.js';
import {
  clear,
  closeAllSheets,
  confirmDialog,
  downloadFile,
  el,
  formatDateJP,
  formatDateTimeJP,
  formatNumber,
  guarded,
  mount,
  openSheet,
  qs,
  readFileAsText,
  toast,
  todayISO,
} from './dom.js';
import { openCopySheet, saveBackupJson } from './save-backup.js';
import { showQrSheet } from './qr-sheet.js';
import { openScanSheet } from './scan-sheet.js';
import { PARENT_VERSION_LABEL } from '../version.js';
import {
  BACKUP_DOWNLOAD_RETRY_MESSAGE,
  BACKUP_FAILED_MESSAGE,
  CONFIRM_REQUIRED_MESSAGE,
  FACTORY_RESET_CHILD_NOTE,
  FACTORY_RESET_CHILD_NOTICE,
  FACTORY_RESET_CHILD_OPTION,
  FACTORY_RESET_CONFIRM_TEXT,
  FACTORY_RESET_DESCRIPTION,
  FACTORY_RESET_DONE_TOAST,
  FACTORY_RESET_ERASED,
  FACTORY_RESET_LABEL,
  FACTORY_RESET_TITLE,
  NO_BACKUP_LABEL,
  PIN_MISMATCH_MESSAGE,
  RESET_FAILED_MESSAGE,
  SAVED_REQUIRED_MESSAGE,
  SAVED_LABEL,
  SAVE_STEP_COPY,
  SAVE_STEP_LEAD,
  SAVE_STEP_LOCKED_NOTE,
  SAVE_STEP_NOTE,
  SAVE_STEP_SHARE,
  SAVE_STEP_TITLE,
  validateFactoryResetInput,
} from '../game/factory-reset.js';

// 解錠状態はタブ内のメモリだけに持つ（再読み込み・再起動では必ず PIN を要求する）
let unlockedFamilyId = null;
const root = () => document.getElementById('parentApp');

function unlockToken(family) {
  unlockedFamilyId = family.familyId;
}

function isUnlocked(family) {
  return Boolean(family) && unlockedFamilyId === family.familyId;
}

function lock() {
  unlockedFamilyId = null;
  initParentScreen();
}

export async function initParentScreen() {
  try {
    const family = await store.getFamily();
    if (!family) return renderSetup();
    if (!isUnlocked(family)) return renderLock(family);
    await renderApp(family);
  } catch (error) {
    console.error(error);
    clear(root());
    mount(root(), el('p', { class: 'fatal', text: `読み込みに失敗しました: ${error?.message ?? error}` }));
  }
}

/* ------------------------------------------------------------ 初期設定 */

function renderSetup() {
  const familyInput = el('input', { class: 'input', type: 'text', id: 'setupFamilyName', maxlength: '20', placeholder: 'たとえば たなか け' });
  const pinInput = el('input', { class: 'input input--pin', type: 'password', inputmode: 'numeric', id: 'setupPin', maxlength: '4', placeholder: '••••' });
  const pinConfirm = el('input', { class: 'input input--pin', type: 'password', inputmode: 'numeric', id: 'setupPinConfirm', maxlength: '4', placeholder: '••••' });
  const error = el('p', { class: 'form-error', hidden: true });

  const submit = el('button', { class: 'btn btn--primary btn--large', type: 'submit', text: 'はじめる' });

  const form = el('form', {
    class: 'stack',
    onsubmit: guarded(async (event) => {
      event.preventDefault();
      error.hidden = true;
      if (pinInput.value !== pinConfirm.value) {
        error.textContent = 'PIN が一致しません';
        error.hidden = false;
        return;
      }
      await store.createFamily({ familyName: familyInput.value, pin: pinInput.value });
      const family = await store.getFamily();
      unlockToken(family);
      toast('家族を登録しました', { tone: 'success' });
      await renderApp(family);
    }),
  }, [
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '家族の名前' }), familyInput]),
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '4桁のPIN（親画面のカギ）' }), pinInput]),
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'PIN（確認）' }), pinConfirm]),
    error,
    submit,
    el('p', { class: 'muted small', text: 'PIN は 4桁の数字です。忘れると親画面に入れなくなります（バックアップから復元して復旧できます）。' }),
    el('hr', { class: 'divider' }),
    el('p', { class: 'muted small', text: 'すでにバックアップがある場合（端末の引っ越し・機種変更）は、こちらから復元してください。' }),
    el('button', {
      class: 'btn btn--ghost',
      type: 'button',
      id: 'setupRestoreButton',
      text: '📂 バックアップから復元',
      onclick: () =>
        openPinRecovery({
          title: 'バックアップから復元',
          description: '前の端末で保存したバックアップを読み込みます。PIN も元のものが引き継がれます。',
        }),
    }),
  ]);

  clear(root());
  mount(root(), 
    el('header', { class: 'p-head p-head--plain' }, [el('h1', { class: 'p-head__title', text: 'たまごフレンズ' })]),
    el('main', { class: 'p-main p-main--narrow' }, [
      el('section', { class: 'card' }, [
        el('h2', { class: 'card__title', text: 'おうちのひとの とうろく' }),
        el('p', { class: 'muted', text: '家族の名前と 4桁の PIN を決めてください。点数の記録は この端末のなかにだけ 保存されます。' }),
        form,
      ]),
    ])
  );
}

/* ------------------------------------------------------------ PIN 解錠 */

function renderLock(family) {
  let buffer = '';
  let submitTimer = 0;
  const dots = el('div', { class: 'pin-dots', 'aria-live': 'polite' });
  const error = el('p', { class: 'form-error', id: 'pinError', hidden: true });
  const pad = el('div', { class: 'pin-pad', id: 'pinPad' });

  function paint() {
    clear(dots);
    for (let index = 0; index < 4; index += 1) {
      dots.append(el('span', { class: `pin-dot ${index < buffer.length ? 'pin-dot--on' : ''}` }));
    }
  }

  async function submitPin() {
    if (!form.isConnected) return; // 解錠後に画面が替わったあとの残入力で発火しない（v49）
    const ok = await store.verifyPin(buffer);
    if (ok) {
      clearTimeout(submitTimer);
      document.onkeydown = null; // 解錠後も数字キーがPINに入る不具合（v49）
      unlockedFamilyId = family.familyId;
      await renderApp(family);
      return;
    }
    const panel = document.querySelector('.pin-panel');
    panel?.classList.add('pin-panel--error');
    error.textContent = 'PIN が違います。もう一度入力してください';
    error.hidden = false;
    buffer = '';
    paint();
    setTimeout(() => panel?.classList.remove('pin-panel--error'), 500);
    toast('PIN が違います', { tone: 'error' });
  }

  function push(digit) {
    if (buffer.length >= 4) return;
    clearTimeout(submitTimer);
    buffer += digit;
    paint();
    if (buffer.length === 4) submitTimer = setTimeout(() => guarded(submitPin)(), 120);
  }

  for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back']) {
    if (digit === 'clear') {
      pad.append(el('button', { class: 'pin-key pin-key--sub', type: 'button', text: 'クリア', onclick: () => { clearTimeout(submitTimer); buffer = ''; paint(); } }));
    } else if (digit === 'back') {
      pad.append(el('button', { class: 'pin-key pin-key--sub', type: 'button', text: '⌫', 'aria-label': '1桁けす', onclick: () => { clearTimeout(submitTimer); buffer = buffer.slice(0, -1); paint(); } }));
    } else {
      pad.append(el('button', { class: 'pin-key', type: 'button', text: digit, onclick: () => push(digit) }));
    }
  }

  document.onkeydown = (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // 入力欄での打鍵をPINにしない（v49）
    if (/^\d$/.test(event.key)) push(event.key);
    else if (event.key === 'Backspace') {
      clearTimeout(submitTimer);
      buffer = buffer.slice(0, -1);
      paint();
    }
  };

  const form = el('form', {
    class: 'pin-panel',
    onsubmit: (event) => {
      event.preventDefault();
      guarded(submitPin)();
    },
  }, [
    el('p', { class: 'pin-panel__label', text: 'おうちのひと用' }),
    el('h1', { class: 'pin-panel__title', text: 'PIN を入力' }),
    el('p', { class: 'muted', text: `${family.familyName} の かぎ` }),
    dots,
    error,
    pad,
    el('button', {
      class: 'btn btn--ghost btn--small',
      type: 'button',
      id: 'pinRecoveryButton',
      text: 'PIN を忘れたとき',
      onclick: () => openPinRecovery(),
    }),
    el('a', { class: 'link-muted', href: './', text: 'こども画面へもどる' }),
  ]);
  paint();

  clear(root());
  mount(root(), 
    el('header', { class: 'p-head p-head--plain' }, [el('h1', { class: 'p-head__title', text: 'たまごフレンズ' })]),
    el('main', { class: 'p-main p-main--narrow p-main--center' }, [form])
  );
  setTimeout(() => qs('.pin-key')?.focus?.(), 50);
}

/**
 * PIN を忘れたときの復旧。リセットボタンは作らず、バックアップからの復元だけを許す。
 * 復元前のデータは自動退避する（消さない）。
 */
function openPinRecovery({
  title = 'PIN を忘れたとき',
  description = 'バックアップから復元すると、PIN も含めて元の状態に戻ります（リセットはできません）。',
} = {}) {
  const pasteField = el('textarea', { class: 'input input--area', rows: 3, id: 'recoveryText', placeholder: 'バックアップJSONを貼り付け' });
  const fileInput = el('input', { class: 'visually-hidden', type: 'file', accept: 'application/json,.json', id: 'recoveryFile' });
  const fileButton = el('button', { class: 'btn btn--ghost', type: 'button', text: '📂 バックアップを選ぶ' });
  const status = el('p', { class: 'muted small' });

  const sheet = openSheet({
    title,
    description,
    content: el('div', { class: 'stack' }, [
      el('p', { class: 'muted small', text: '復元する前に、いまこの端末にあるデータを自動で退避します。' }),
      fileButton,
      fileInput,
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'または JSON を貼り付け' }), pasteField]),
      status,
    ]),
    actions: [
      { label: 'やめる', onClick: (close) => close() },
      {
        label: '復元する',
        variant: 'primary',
        onClick: guarded(async (close) => {
          const text = pasteField.value.trim();
          if (!text) {
            status.textContent = 'バックアップを選ぶか、JSONを貼り付けてください';
            return;
          }
          const result = await store.restoreBackup(text);
          close();
          toast(`復元しました（${result.restored}件）。PIN は復元したデータのものになります`, { tone: 'success', duration: 4200 });
          await initParentScreen();
        }),
      },
    ],
  });

  fileButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      pasteField.value = await readFileAsText(file);
      status.textContent = `読み込みました: ${file.name}`;
    } catch (error) {
      status.textContent = error?.message ?? '読み込めませんでした';
    } finally {
      fileInput.value = '';
    }
  });
  return sheet;
}

/* ------------------------------------------------------------ アプリ本体 */

let currentFamily = null;

async function renderApp(family) {
  currentFamily = family;
  const overview = await store.overview();

  clear(root());
  const header = el('header', { class: 'p-head' }, [
    el('div', { class: 'p-head__id' }, [
      el('p', { class: 'p-head__eyebrow', text: 'たまごフレンズ' }),
      el('h1', { class: 'p-head__title', text: family.familyName }),
    ]),
    el('div', { class: 'p-head__actions' }, [
      el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: '🔒 ロック', onclick: lock }),
    ]),
  ]);

  const tabs = el('nav', { class: 'tabs', 'aria-label': '画面' });
  const main = el('main', { class: 'p-main', id: 'pMain' });

  const views = [
    { key: 'children', label: 'こども', hash: '#/' },
    { key: 'data', label: 'データ', hash: '#/data' },
  ];

  // 版（v24）。PIN 解錠後の画面の最下部に、押せない1行として出す
  const footer = el('footer', { class: 'p-foot' }, [
    // v41: あそびかたガイド（別タブ）。版表示の上
    el('a', {
      class: 'guide-link',
      id: 'parentGuideLink',
      href: './guide.html',
      target: '_blank',
      rel: 'noopener noreferrer',
      text: 'あそびかたガイド',
    }),
    el('p', { class: 'muted small app-version', id: 'parentVersionNote', text: PARENT_VERSION_LABEL }),
  ]);

  mount(root(), header, tabs, main, footer);

  function paintTabs(active) {
    clear(tabs);
    for (const view of views) {
      tabs.append(
        el('a', {
          class: `tab ${view.key === active ? 'tab--on' : ''}`,
          href: view.hash,
          text: view.label,
        })
      );
    }
  }

  async function route() {
    const hash = location.hash || '#/';
    if (hash.startsWith('#/child/')) {
      const childId = hash.slice('#/child/'.length);
      paintTabs('children');
      await renderChildDetail(main, childId);
      return;
    }
    if (hash.startsWith('#/rewards')) {
      // ごほうびは「親のメモ」に変更したため、こども一覧へ戻す
      location.hash = '#/';
      return;
    }
    if (hash.startsWith('#/data')) {
      paintTabs('data');
      await renderData(main);
      return;
    }
    paintTabs('children');
    await renderOverview(main, overview);
  }

  window.onhashchange = () => guarded(route)();
  await route();
}

/* ------------------------------------------------------------ こども一覧 */

async function renderOverview(main, rows) {
  clear(main);
  mount(main, 
    el('div', { class: 'section-head' }, [
      el('h2', { class: 'section-head__title', text: 'こども' }),
      el('button', {
        class: 'btn btn--primary btn--small',
        type: 'button',
        id: 'addChildButton',
        text: '＋ こどもを追加',
        onclick: () => openAddChild(),
      }),
    ])
  );

  if (!rows.length) {
    mount(main, 
      el('section', { class: 'card empty-state' }, [
        el('p', { class: 'empty-state__title', text: 'まだ こどもが いません' }),
        el('p', { class: 'muted', text: '「こどもを追加」から 登録すると、点数を記録できます。' }),
      ])
    );
    return;
  }

  for (const child of rows) {
    const { summary } = child;
    const badges = [];
    if (child.pendingCount) badges.push(el('span', { class: 'tag tag--info', text: `未送信 ${child.pendingCount}件` }));
    if (child.correctionCount) badges.push(el('span', { class: 'tag tag--warn', text: `訂正QR ${child.correctionCount}件` }));

    mount(main, 
      el('a', {
        class: 'card child-row',
        href: `#/child/${child.id}`,
        dataset: { total: String(summary.total), hatch: String(summary.hatchTokens) },
      }, [
        el('div', { class: 'child-row__head' }, [
          el('span', { class: 'child-row__emoji', text: child.emoji ?? '🐣' }),
          el('div', { class: 'child-row__names' }, [
            el('span', { class: 'child-row__name', text: child.name }),
            el('span', { class: 'child-row__sub', text: `累計 ${formatNumber(summary.total)}点 ・ 孵化権 ×${summary.hatchTokens}` }),
          ]),
          el('span', { class: 'child-row__chevron', text: '›' }),
        ]),
        el('div', { class: 'progress progress--slim' }, [
          el('div', { class: 'progress__bar', style: { width: `${summary.progress * 100}%` } }),
        ]),
        el('div', { class: 'child-row__foot' }, [
          el('span', { class: 'muted small', text: `つぎの孵化まで あと ${formatNumber(summary.nextHatchNeed)}点` }),
          badges.length ? el('span', { class: 'child-row__tags' }, badges) : null,
        ]),
      ])
    );
  }
}

function openAddChild() {
  const nameInput = el('input', { class: 'input', type: 'text', maxlength: '20', id: 'newChildName', placeholder: '名前（ニックネーム）' });
  const emojiInput = el('input', { class: 'input input--emoji', type: 'text', maxlength: '2', value: '🐣', id: 'newChildEmoji', 'aria-label': 'アイコン' });
  const emojiChoices = ['🐣', '🐰', '🐻', '🐼', '🦊', '🐱', '🐶', '🦄', '🐧', '🐨'];
  const picker = el('div', { class: 'emoji-picker' });
  for (const emoji of emojiChoices) {
    picker.append(
      el('button', {
        class: 'emoji-choice',
        type: 'button',
        text: emoji,
        onclick: () => {
          emojiInput.value = emoji;
        },
      })
    );
  }

  const sheet = openSheet({
    title: 'こどもを追加',
    content: el('form', { class: 'stack', id: 'addChildForm' }, [
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '名前' }), nameInput]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'アイコン' }), el('div', { class: 'row' }, [emojiInput, picker])]),
    ]),
    actions: [
      { label: 'キャンセル', onClick: (close) => close() },
      {
        label: '追加する',
        variant: 'primary',
        onClick: guarded(async (close) => {
          await store.addChild({ name: nameInput.value, emoji: emojiInput.value || '🐣' });
          close();
          toast('こどもを追加しました', { tone: 'success' });
          await refresh();
        }),
      },
    ],
  });
  setTimeout(() => nameInput.focus(), 60);
  return sheet;
}

async function refresh() {
  const family = await store.getFamily();
  if (family) await renderApp(family);
}

/* ------------------------------------------------------------ こども詳細 */

function qrCountNote(count, sheetCount) {
  return sheetCount === 1
    ? `合計 ${count}件を1枚のQRにまとめています。`
    : `合計 ${count}件を ${sheetCount}枚に分けています。1枚ずつ順番に読み取ってください。`;
}

const RESEND_NOTE = 'すでに受け取っている記録は二重に加算されません（イベントIDで判定）。';

async function renderChildDetail(main, childId) {
  const child = await store.getChild(childId);
  clear(main);
  if (!child || child.deleted) {
    mount(main, el('p', { class: 'muted', text: 'こどもが見つかりません' }));
    return;
  }
  const summary = summarize(child);
  const scores = await store.listScores(childId);
  const pending = scores.filter((score) => !score.sentAt);
  const corrections = await store.listPendingCorrections(childId);
  const allCorrections = await store.listCorrections(childId);
  const memos = await store.ensureMemos(childId);
  const audit = await store.listAudit({ childId, limit: 40 });

  mount(main, 
    el('div', { class: 'section-head' }, [
      el('a', { class: 'back-link', href: '#/', text: '‹ こども一覧' }),
    ]),

    el('section', { class: 'card child-summary' }, [
      el('div', { class: 'child-summary__head' }, [
        el('span', { class: 'child-summary__emoji', text: child.emoji ?? '🐣' }),
        el('div', {}, [
          el('h2', { class: 'child-summary__name', text: child.name }),
          el('p', { class: 'muted small', text: `登録 ${formatDateJP(child.createdAt)}` }),
        ]),
      ]),
      el('div', { class: 'stat-grid' }, [
        el('div', { class: 'stat' }, [el('span', { class: 'stat__label', text: '累計' }), el('span', { class: 'stat__value', id: 'statTotal', text: formatNumber(summary.total) })]),
        el('div', { class: 'stat' }, [
          el('span', { class: 'stat__label' }, [
            el('span', { class: 'label-wide', text: '次の孵化まで' }),
            el('span', { class: 'label-narrow', text: '次まで' }),
          ]),
          el('span', { class: 'stat__value', id: 'statNeed', text: formatNumber(summary.nextHatchNeed) }),
        ]),
        el('div', { class: 'stat' }, [el('span', { class: 'stat__label', text: '孵化権' }), el('span', { class: 'stat__value', id: 'statHatch', text: `×${summary.hatchTokens}` })]),
      ]),
      el('div', { class: 'progress' }, [el('div', { class: 'progress__bar', style: { width: `${summary.progress * 100}%` } })]),
      el('p', { class: 'muted small', text: `最高到達点 ${formatNumber(summary.highWaterMark)}点（訂正で累計が下がっても孵化権は減りません）` }),
    ]),

    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title', text: '点数のQR' }),
      el('p', { class: 'muted small', id: 'qrHint', text: pending.length || corrections.length ? '' : '送信していない点数はありません。' }),
      el('div', { class: 'button-row' }, [
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          id: 'scoreQrButton',
          disabled: pending.length === 0,
          text: pending.length ? `点数QRを表示（${pending.length}件）` : '点数QRを表示',
          onclick: guarded(async () => {
            const result = await store.buildScoreQr(childId);
            if (!result.qrs.length) {
              toast('送信する点数がありません', { tone: 'info' });
              return;
            }
            showQrSheet({
              title: '点数のQR',
              description: 'こどもの端末で読み取ってください。読み取った時点で「送信済み」になります。',
              qrs: result.qrs,
              note: qrCountNote(result.count, result.qrs.length),
            });
            await renderChildDetail(main, childId);
          }),
        }),
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          id: 'correctionQrButton',
          disabled: corrections.length === 0,
          text: corrections.length ? `訂正QRを表示（${corrections.length}件）` : '訂正QR',
          onclick: guarded(async () => {
            const result = await store.buildCorrectionQr(childId);
            if (!result.qrs.length) return;
            showQrSheet({
              title: '訂正のQR',
              description: '訂正・削除の内容をこどもの端末へ送ります（累計だけが直り、孵化権は減りません）。',
              qrs: result.qrs,
              note: qrCountNote(result.count, result.qrs.length),
            });
            await renderChildDetail(main, childId);
          }),
        }),
      ]),
      el('div', { class: 'button-row' }, [
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          id: 'pairingQrButton',
          text: '🔗 かぞくQR（初回ペアリング）',
          onclick: guarded(async () => {
            const ok = await confirmDialog({
              title: 'かぞくQRを表示しますか？',
              message: 'このQRには家族のカギが入っています。こどもの端末で読み取るまで、他の人に見せないでください。',
              confirmLabel: '表示する',
            });
            if (!ok) return;
            const result = await store.buildPairingQr(childId);
            showQrSheet({
              title: 'かぞくQR',
              description: `${child.name} の端末で読み取ってください（1回だけ）。`,
              qrs: result.qrs,
            });
          }),
        }),
      ]),
      el('details', { class: 'resend' }, [
        el('summary', { class: 'resend__summary', text: '送信済みの記録をQRで再送する（読み取り失敗・端末の入れ替え）' }),
        el('p', { class: 'muted small', text: '読み取りに失敗したときや子端末を替えたときに使います。' + RESEND_NOTE }),
        el('div', { class: 'button-row' }, [
          el('button', {
            class: 'btn btn--ghost btn--small',
            type: 'button',
            id: 'resendAllScores',
            disabled: scores.length === 0,
            text: `点数の全履歴を再送（${scores.length}件）`,
            onclick: guarded(async () => {
              const result = await store.buildScoreQr(childId, { all: true });
              if (!result.qrs.length) return;
              showQrSheet({
                title: '点数のQR（全履歴）',
                description: 'こどもの端末で読み取ってください。',
                qrs: result.qrs,
                note: `${qrCountNote(result.count, result.qrs.length)}${RESEND_NOTE}`,
              });
              await renderChildDetail(main, childId);
            }),
          }),
          el('button', {
            class: 'btn btn--ghost btn--small',
            type: 'button',
            id: 'resendAllCorrections',
            disabled: allCorrections.length === 0,
            text: `訂正の全履歴を再送（${allCorrections.length}件）`,
            onclick: guarded(async () => {
              const result = await store.buildCorrectionQr(childId, { all: true });
              if (!result.qrs.length) return;
              showQrSheet({
                title: '訂正のQR（全履歴）',
                description: 'こどもの端末で読み取ってください。',
                qrs: result.qrs,
                note: `${qrCountNote(result.count, result.qrs.length)}${RESEND_NOTE}`,
              });
              await renderChildDetail(main, childId);
            }),
          }),
        ]),
      ]),
    ]),

    renderScoreForm(childId),

    el('section', { class: 'card' }, [
      el('div', { class: 'card__head' }, [
        el('h2', { class: 'card__title', text: '点数の履歴' }),
        el('span', { class: 'card__count', text: `${scores.length}件` }),
      ]),
      scores.length ? renderScoreList(scores, childId, main) : el('p', { class: 'muted', text: 'まだ記録がありません。' }),
    ]),

    allCorrections.length
      ? el('section', { class: 'card' }, [
          el('div', { class: 'card__head' }, [
            el('h2', { class: 'card__title', text: '訂正の履歴' }),
            el('span', { class: 'card__count', text: `${allCorrections.length}件` }),
          ]),
          el('p', { class: 'muted small', text: '子端末の累計を合わせるためのマイナス差分です。再表示しても二重には適用されません。' }),
          el('ul', { class: 'correction-list' }, allCorrections.map((row) => el('li', { class: 'correction-item' }, [
            el('span', { class: 'correction-item__points', text: row.reason === 'delete' ? '—' : `${formatNumber(row.points)}点` }),
            el('div', { class: 'correction-item__body' }, [
              el('span', { class: 'correction-item__name', text: `${row.reason === 'delete' ? '削除' : '訂正後'}: ${row.testName ?? '—'}` }),
              el('span', { class: 'correction-item__meta', text: `${formatDateTimeJP(row.createdAt)} ・ ${row.deliveredAt ? '送信済み' : '未送信'}` }),
            ]),
            el('button', {
              class: 'btn btn--ghost btn--small',
              type: 'button',
              text: 'QR',
              'aria-label': `${row.testName ?? '訂正'} の訂正QRを再表示`,
              onclick: guarded(async () => {
                const result = await store.buildCorrectionQr(childId, { eventIds: [row.id] });
                if (!result.qrs.length) return;
                showQrSheet({
                  title: '訂正のQR（再表示）',
                  description: 'こどもの端末で読み取ってください。',
                  qrs: result.qrs,
                  note: qrCountNote(result.count, result.qrs.length) + RESEND_NOTE,
                });
                await renderChildDetail(main, childId);
              }),
            }),
          ]))),
        ])
      : null,

    el('section', { class: 'card', id: 'memoCard' }, [
      el('div', { class: 'card__head' }, [
        el('h2', { class: 'card__title', text: 'ごほうびメモ' }),
        el('span', { class: 'card__count', text: `${memos.length}件` }),
      ]),
      el('p', { class: 'muted small', text: '1,000点達成ごとに1行できます。内容はあとから書けます（書かなくても大丈夫）。' }),
      memos.length ? renderMemoList(memos, childId, main) : el('p', { class: 'muted', text: 'まだ1,000点に届いていません。' }),
    ]),

    el('section', { class: 'card' }, [
      el('div', { class: 'card__head' }, [
        el('h2', { class: 'card__title', text: '監査履歴' }),
        el('span', { class: 'card__count', text: '変更前後・日時' }),
      ]),
      renderAuditList(audit),
    ]),

    el('section', { class: 'card', id: 'recoveryCard' }, [
      el('h2', { class: 'card__title', text: 'リカバリー（端末が初期状態に戻ったとき）' }),
      el('p', { class: 'muted small', text: 'こどもの端末が初期化された・データが消えたときに、これまでのQRを1画面にまとめて表示します。こどもの端末で上から順に読み取るだけで、点数が戻ります（読み取り済みのQRは二重に加算されません）。' }),
      el('div', { class: 'recovery-flow' }, [
        el('span', { class: 'recovery-flow__step', text: '① かぞくQR' }),
        el('span', { class: 'recovery-flow__arrow', text: '→' }),
        el('span', { class: 'recovery-flow__step', text: '② 点数 全履歴' }),
        el('span', { class: 'recovery-flow__arrow', text: '→' }),
        el('span', { class: 'recovery-flow__step', text: '③ 訂正' }),
        el('span', { class: 'recovery-flow__arrow', text: '→' }),
        el('span', { class: 'recovery-flow__step', text: '④ ごほうび' }),
      ]),
      el('div', { class: 'button-row' }, [
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          id: 'recoveryQrButton',
          text: `リカバリーQRをまとめて表示（${scores.length + allCorrections.length}件）`,
          onclick: guarded(() => openRecoverySheet(childId, child, main)),
        }),
      ]),
      el('p', { class: 'muted small', text: 'ペット・コイン・へやの様子は親の記録に残らないため、このQRでは戻りません（次期対応）。' }),
    ]),

    el('section', { class: 'card', id: 'resetCard' }, [
      el('h2', { class: 'card__title', text: 'この子の端末を初期化' }),
      el('p', { class: 'muted small', text: '端末を初期化するQRを発行します。実行するには子どもの端末で読み取る必要があります。親の記録（点数・監査履歴）は残ります。' }),
      el('div', { class: 'button-row' }, [
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          id: 'resetQrButton',
          text: '🔁 初期化QRを発行',
          onclick: guarded(() => openResetSheet(childId, child)),
        }),
      ]),
    ]),

    el('section', { class: 'card danger-zone' }, [
      el('h2', { class: 'card__title', text: 'このこどもを削除' }),
      el('p', { class: 'muted small', text: '点数・ごほうび・監査履歴もまとめて削除されます。こどもの端末に残っている記録は消えません。' }),
      el('button', {
        class: 'btn btn--danger btn--small',
        type: 'button',
        text: '削除する',
        onclick: guarded(async () => {
          const ok = await confirmDialog({
            title: `${child.name} を削除しますか？`,
            message: 'この操作は取り消せません。バックアップを取ってから行うことをおすすめします。',
            confirmLabel: '削除する',
            danger: true,
            requireText: child.name,
            inputLabel: `確認のため「${child.name}」と入力してください`,
          });
          if (!ok) return;
          await store.deleteChild(childId);
          toast('削除しました', { tone: 'success' });
          location.hash = '#/';
          await refresh();
        }),
      }),
    ])
  );

  qs('#qrHint', main).textContent = pending.length || corrections.length
    ? `未送信 ${pending.length}件 / 未送信の訂正 ${corrections.length}件`
    : '未送信の点数はありません（送信済みは下の「再送」や履歴の「QR」から表示できます）。';
}

/**
 * リカバリーQR（v45）。
 * 端末が初期状態に戻ったとき、①かぞくQR → ②点数全履歴 → ③訂正全履歴 → ④ごほうび を
 * 1枚のシートにまとめて出し、こども側は「連続読み取り」で上から順に読み取るだけで復旧できる。
 * 子端末はイベントIDで重複排除するので、途中まで読んだ・二重に読んだ場合も二重加算されない。
 */
async function openRecoverySheet(childId, child, main) {
  const [pair, scoreQr, correctionQr, rewardQr] = await Promise.all([
    store.buildPairingQr(childId),
    store.buildScoreQr(childId, { all: true }),
    store.buildCorrectionQr(childId, { all: true }),
    store.buildRewardsQr(childId),
  ]);

  const sections = [];
  sections.push({
    heading: '① かぞくQR（さいしょに読む）',
    note: 'こどもの端末をこの家族にペアリングしなおします。1回だけ読み取ってください。',
    qrs: pair.qrs,
    labels: ['かぞくQR'],
  });
  if (scoreQr.qrs.length) {
    sections.push({
      heading: `② 点数のQR（全履歴 ${scoreQr.count}件）`,
      note: qrCountNote(scoreQr.count, scoreQr.qrs.length) + RESEND_NOTE,
      qrs: scoreQr.qrs,
      labels: scoreQr.qrs.map((_, index) => `点数 ${index + 1}/${scoreQr.qrs.length}`),
    });
  }
  if (correctionQr.qrs.length) {
    sections.push({
      heading: `③ 訂正のQR（全履歴 ${correctionQr.count}件）`,
      note: '点数を読み終わってから読み取ってください（先に読むと適用されません）。',
      qrs: correctionQr.qrs,
      labels: correctionQr.qrs.map((_, index) => `訂正 ${index + 1}/${correctionQr.qrs.length}`),
    });
  }
  if (rewardQr.qrs.length) {
    sections.push({
      heading: `④ ごほうびのQR（${rewardQr.count}件）`,
      note: 'ごほうびの一覧を戻します（任意）。',
      qrs: rewardQr.qrs,
      labels: rewardQr.qrs.map((_, index) => `ごほうび ${index + 1}/${rewardQr.qrs.length}`),
    });
  }

  const total = sections.reduce((sum, section) => sum + section.qrs.length, 0);
  if (!total) {
    toast('表示できるQRがありません', { tone: 'info' });
    return;
  }

  showQrSheet({
    title: 'リカバリーQR',
    description: `${child.name} の端末で読み取ってください。読み取りは「つづけて読み取る」で連続して行えます。`,
    sections,
    note: `全 ${total}枚。1,000点ごとの孵化権もQRに入っています。読み取り済みのQRは二重に加算されません。`,
  });
  await renderChildDetail(main, childId);
}

function renderScoreForm(childId) {
  const nameInput = el('input', { class: 'input', type: 'text', id: 'scoreName', maxlength: '40', placeholder: 'たとえば さんすう テスト', required: true });
  const dateInput = el('input', { class: 'input', type: 'date', id: 'scoreDate', value: todayISO(), required: true });
  const pointsInput = el('input', { class: 'input', type: 'number', id: 'scorePoints', inputmode: 'numeric', min: '0', max: '100000', step: '1', placeholder: '85', required: true });

  const form = el('form', {
    class: 'stack',
    id: 'scoreForm',
    onsubmit: guarded(async (event) => {
      event.preventDefault();
      const result = await store.addScore({
        childId,
        testName: nameInput.value,
        date: dateInput.value,
        points: pointsInput.value,
      });
      nameInput.value = '';
      pointsInput.value = '';
      dateInput.value = todayISO();
      toast(
        result.granted
          ? `${formatNumber(result.granted * 1000)}点を超えました！孵化権 +${result.granted}`
          : '点数を記録しました',
        { tone: 'success' }
      );
      await refreshHash();
    }),
  }, [
    el('div', { class: 'form-grid' }, [
      el('label', { class: 'field field--wide' }, [el('span', { class: 'field__label', text: 'テスト名' }), nameInput]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '日付' }), dateInput]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '点数（0〜100,000）' }), pointsInput]),
    ]),
    el('p', { class: 'muted small', id: 'scoreHint', text: '点数は 0〜100,000 点の整数です（マイナス・小数は入力できません）。0点も記録できます。' }),
    el('button', { class: 'btn btn--primary btn--large', type: 'submit', id: 'scoreSubmit', text: '点数を記録する' }),
  ]);

  return el('section', { class: 'card' }, [
    el('h2', { class: 'card__title', text: '点数を記録' }),
    form,
  ]);
}

function renderScoreList(scores, childId, main) {
  const list = el('ul', { class: 'score-list' });
  for (const score of scores) {
    list.append(
      el('li', { class: 'score-item' }, [
        el('div', { class: 'score-item__main' }, [
          el('span', { class: 'score-item__points', text: `+${formatNumber(score.points)}` }),
          el('div', { class: 'score-item__body' }, [
            el('span', { class: 'score-item__name', text: score.testName }),
            el('span', { class: 'score-item__meta', text: `${formatDateJP(score.date)}${score.sentAt ? ' ・ 送信済み' : ' ・ 未送信'}` }),
          ]),
        ]),
        el('div', { class: 'score-item__actions' }, [
          el('button', {
            class: 'btn btn--ghost btn--small',
            type: 'button',
            text: 'QR',
            'aria-label': `${score.testName} のQRを表示`,
            onclick: guarded(async () => {
              const result = await store.buildScoreQr(childId, { scoreIds: [score.id] });
              if (!result.qrs.length) {
                toast('QRを作れませんでした', { tone: 'error' });
                return;
              }
              showQrSheet({
                title: '点数のQR（再表示）',
                description: `${score.testName}（${formatNumber(score.points)}点）をこどもの端末へ送ります。`,
                qrs: result.qrs,
                note: qrCountNote(result.count, result.qrs.length) + RESEND_NOTE,
              });
              await renderChildDetail(main, childId);
            }),
          }),
          el('button', {
            class: 'btn btn--ghost btn--small',
            type: 'button',
            text: '訂正',
            onclick: () => openEditScore(score, childId),
          }),
          el('button', {
            class: 'btn btn--ghost btn--small btn--danger-text',
            type: 'button',
            text: '削除',
            onclick: guarded(async () => {
              const ok = await confirmDialog({
                title: '点数を削除',
                message: `「${score.testName}」(${formatNumber(score.points)}点) を削除します。累計は再計算され、孵化権は減りません。${score.sentAt ? '\nこどもの端末へは訂正QRで反映します。' : ''}`,
                confirmLabel: '削除する',
                danger: true,
              });
              if (!ok) return;
              await store.deleteScore(score.id);
              toast('削除しました（累計を再計算しました）', { tone: 'success' });
              await renderChildDetail(main, childId);
            }),
          }),
        ]),
      ])
    );
  }
  return list;
}

/** ごほうびメモの一覧（達成点の降順・その場で編集・メモを消す） */
function renderMemoList(memos, childId, main) {
  const list = el('ul', { class: 'memo-list', id: 'memoList' });
  for (const memo of memos) {
    const input = el('input', {
      class: 'input memo-input',
      type: 'text',
      maxlength: '60',
      value: memo.content ?? '',
      placeholder: 'れい: すきなアイス / 外食',
      'aria-label': `${formatNumber(memo.points)}点のごほうびメモ`,
      dataset: { memoPoints: String(memo.points) },
    });
    const save = guarded(async () => {
      await store.saveMemo(childId, memo.points, input.value);
      toast('メモを ほぞんしました', { tone: 'success', duration: 1400 });
    });
    input.addEventListener('blur', () => {
      if (input.value !== (memo.content ?? '')) save();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
    });

    list.append(
      el('li', { class: 'memo-item', dataset: { points: String(memo.points) } }, [
        el('div', { class: 'memo-item__head' }, [
          el('span', { class: 'memo-item__points', text: `${formatNumber(memo.points)}点` }),
          el('span', { class: 'memo-item__date', text: memo.achievedAt ? formatDateJP(memo.achievedAt) : '—' }),
        ]),
        el('div', { class: 'memo-item__row' }, [
          input,
          el('button', {
            class: 'btn btn--ghost btn--small',
            type: 'button',
            text: 'メモを消す',
            disabled: !memo.content,
            onclick: guarded(async () => {
              const ok = await confirmDialog({
                title: 'メモを消しますか？',
                message: '達成の行は残ります（あとから また書けます）。',
                confirmLabel: '消す',
              });
              if (!ok) return;
              await store.clearMemo(childId, memo.points);
              await renderChildDetail(main, childId);
            }),
          }),
        ]),
      ])
    );
  }
  return list;
}

function openEditScore(score, childId) {
  const nameInput = el('input', { class: 'input', type: 'text', value: score.testName, maxlength: '40' });
  const dateInput = el('input', { class: 'input', type: 'date', value: score.date });
  const pointsInput = el('input', { class: 'input', type: 'number', value: String(score.points), min: '1', step: '1' });

  const sheet = openSheet({
    title: '点数の訂正',
    description: '訂正すると累計を再計算します。孵化権は減りません。',
    content: el('div', { class: 'stack' }, [
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'テスト名' }), nameInput]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '日付' }), dateInput]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '点数' }), pointsInput]),
      score.sentAt ? el('p', { class: 'muted small', text: 'この点数は子端末へ送信済みです。訂正QRで子端末に反映してください。' }) : null,
    ]),
    actions: [
      { label: 'キャンセル', onClick: (close) => close() },
      {
        label: '保存する',
        variant: 'primary',
        onClick: guarded(async (close) => {
          const result = await store.editScore(score.id, {
            testName: nameInput.value,
            date: dateInput.value,
            points: pointsInput.value,
          });
          close();
          toast(
            result.granted > 0 ? `訂正しました（孵化権 +${result.granted}）` : '訂正しました（累計を再計算しました）',
            { tone: 'success' }
          );
          await refreshHash();
        }),
      },
    ],
  });
  return sheet;
}

function renderAuditList(audit) {
  if (!audit.length) return el('p', { class: 'muted', text: 'まだ履歴がありません。' });
  const labels = {
    family_create: '家族を作成',
    family_rename: '家族名の変更',
    pin_change: 'PINの変更',
    child_add: 'こどもを追加',
    child_edit: 'こどもの変更',
    child_delete: 'こどもを削除',
    score_add: '点数を追加',
    score_edit: '点数を訂正',
    score_delete: '点数を削除',
    memo_save: 'ごほうびメモ',
    device_reset_issued: '端末の初期化QRを発行',
    reward_add: 'ごほうびを登録（旧）',
    reward_edit: 'ごほうびを変更',
    reward_delete: 'ごほうびを削除',
    reward_request: 'ごほうび申請',
    reward_approved: 'ごほうびを承認',
    reward_rejected: 'ごほうびを却下',
  };
  const describe = (snapshot) => {
    if (!snapshot) return '—';
    const parts = [];
    if (snapshot.testName !== undefined) parts.push(snapshot.testName);
    if (snapshot.points !== undefined) parts.push(`${formatNumber(snapshot.points)}点`);
    if (snapshot.title !== undefined) parts.push(snapshot.title);
    return parts.join(' / ') || '—';
  };

  const describeEntry = (entry) => {
    if (entry.before && entry.after) {
      // テスト名が同じなら点数だけを示す（「76点 → 66点」）
      if (entry.before.testName === entry.after.testName) {
        return `${formatNumber(entry.before.points)}点 → ${formatNumber(entry.after.points)}点`;
      }
      return `${describe(entry.before)} → ${describe(entry.after)}`;
    }
    if (entry.after) return `追加: ${describe(entry.after)}`;
    if (entry.before) return `削除: ${describe(entry.before)}`;
    return null;
  };

  const list = el('ul', { class: 'audit-list' });
  for (const entry of audit) {
    const changes = [];
    const summary = describeEntry(entry);
    if (summary) changes.push(summary);
    if (entry.totalBefore !== null && entry.totalAfter !== null && entry.totalBefore !== undefined) {
      changes.push(`累計 ${formatNumber(entry.totalBefore)} → ${formatNumber(entry.totalAfter)}`);
    }
    list.append(
      el('li', { class: 'audit-item' }, [
        el('div', { class: 'audit-item__head' }, [
          el('span', { class: 'audit-item__type', text: labels[entry.type] ?? entry.type }),
          el('span', { class: 'audit-item__at', text: formatDateTimeJP(entry.at) }),
        ]),
        changes.length ? el('p', { class: 'audit-item__detail', text: changes.join(' / ') }) : null,
      ])
    );
  }
  return list;
}

/* ------------------------------------------------------------ ごほうび */

/** 初期化QRの発行（PIN確認 → モード選択 → 署名付きQR） */
function openResetSheet(childId, child) {
  const pinInput = el('input', { class: 'input input--pin', type: 'password', inputmode: 'numeric', maxlength: '4', id: 'resetPin', 'aria-label': 'PIN' });
  const modeA = el('input', { type: 'radio', name: 'resetMode', id: 'resetModeKeep', value: 'keep-pets', checked: true, class: 'radio' });
  const modeB = el('input', { type: 'radio', name: 'resetMode', id: 'resetModeFactory', value: 'factory', class: 'radio' });
  const error = el('p', { class: 'form-error', hidden: true });

  const sheet = openSheet({
    title: '端末の初期化QR',
    description: `${child.name} の端末を初期化します。モードを選んでください。`,
    content: el('div', { class: 'stack' }, [
      el('div', { class: 'radio-card' }, [
        modeA,
        el('label', { for: 'resetModeKeep' }, [
          el('strong', { text: 'A: ペットを残す' }),
          el('span', { class: 'muted small', text: '消える: 点数履歴・累計・進捗・孵化権・ごほうび一覧・ペアリング／残る: ペット・コイン・音の設定' }),
        ]),
      ]),
      el('div', { class: 'radio-card' }, [
        modeB,
        el('label', { for: 'resetModeFactory' }, [
          el('strong', { text: 'B: 完全初期化' }),
          el('span', { class: 'muted small', text: '消える: 上記すべて＋ペット・コイン・音の設定（アプリを入れた直後の状態）' }),
        ]),
      ]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'PIN（4桁）' }), pinInput]),
      error,
      el('p', { class: 'muted small', text: 'この操作は監査履歴に記録されます。' }),
    ]),
    actions: [
      { label: 'やめる', onClick: (close) => close() },
      {
        label: 'QRを発行',
        variant: 'primary',
        onClick: guarded(async (close) => {
          const ok = await store.verifyPin(pinInput.value);
          if (!ok) {
            error.textContent = 'PIN が違います';
            error.hidden = false;
            pinInput.value = '';
            pinInput.focus();
            return;
          }
          const mode = modeB.checked ? 'factory' : 'keep-pets';
          const result = await store.buildResetQr(childId, mode);
          close();
          showQrSheet({
            title: '初期化QR',
            description: `${child.name} の端末で読み取ってください。読み取ると確認のうえ初期化されます。`,
            qrs: result.qrs,
            note: mode === 'factory'
              ? 'B: 完全初期化（ペット・コイン・音の設定も消えます）'
              : 'A: ペット・コイン・音の設定は残ります',
          });
        }),
      },
    ],
  });
  setTimeout(() => pinInput.focus(), 80);
  return sheet;
}

/* ------------------------------------------------------------ データ */

async function renderData(main) {
  const family = await store.getFamily();
  const snapshots = await store.listSnapshots();
  clear(main);

  const restoreField = el('textarea', { class: 'input input--area', rows: 4, id: 'restoreText', placeholder: 'バックアップJSONを貼り付け' });
  const restoreFile = el('input', { class: 'visually-hidden', type: 'file', accept: 'application/json,.json', id: 'restoreFile' });

  const pinCurrent = el('input', { class: 'input input--pin', type: 'password', inputmode: 'numeric', maxlength: '4', id: 'pinCurrent' });
  const pinNext = el('input', { class: 'input input--pin', type: 'password', inputmode: 'numeric', maxlength: '4', id: 'pinNext' });
  const familyName = el('input', { class: 'input', type: 'text', maxlength: '20', value: family.familyName, id: 'familyNameInput' });

  mount(main, 
    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title', text: 'バックアップ' }),
      el('p', { class: 'muted small', text: '家族・こども・点数・監査履歴・ごほうびを JSON で保存します。端末を変えるときや PIN を忘れたときの復旧に使えます。' }),
      el('div', { class: 'button-row' }, [
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          id: 'backupButton',
          text: '⬇ バックアップを保存',
          onclick: guarded(async () => {
            const backup = await store.exportBackup();
            await saveBackupJson({ filename: store.backupFileName(), text: JSON.stringify(backup, null, 2) });
          }),
        }),
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          id: 'backupViewButton',
          text: '内容を表示',
          onclick: guarded(async () => {
            const backup = await store.exportBackup();
            openCopySheet({
              filename: store.backupFileName(),
              text: JSON.stringify(backup, null, 2),
              title: 'バックアップの内容',
            });
          }),
        }),
      ]),
    ]),

    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title', text: '復元' }),
      el('p', { class: 'muted small', text: '復元する前に、いまのデータを自動で退避します（消さません）。' }),
      el('div', { class: 'button-row' }, [
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          id: 'restoreFileButton',
          text: '📂 ファイルを選ぶ',
          onclick: () => restoreFile.click(),
        }),
        restoreFile,
      ]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'または JSON を貼り付け' }), restoreField]),
      el('button', {
        class: 'btn btn--primary',
        type: 'button',
        id: 'restoreButton',
        text: '貼り付けた内容で復元',
        onclick: guarded(async () => {
          if (!restoreField.value.trim()) {
            toast('復元するJSONを貼り付けてください', { tone: 'info' });
            return;
          }
          await runRestore(restoreField.value);
        }),
      }),
    ]),

    el('section', { class: 'card' }, [
      el('div', { class: 'card__head' }, [
        el('h2', { class: 'card__title', text: '自動退避' }),
        el('span', { class: 'card__count', text: `${snapshots.length}件` }),
      ]),
      snapshots.length
        ? el('ul', { class: 'snapshot-list' }, snapshots.map((snapshot) => el('li', { class: 'snapshot-item' }, [
            el('div', {}, [
              el('span', { class: 'snapshot-item__label', text: snapshot.label ?? '自動退避' }),
              el('span', { class: 'muted small', text: `${formatDateTimeJP(snapshot.at)} ・ ${snapshot.counts ?? 0}件` }),
            ]),
            el('div', { class: 'button-row' }, [
              el('button', {
                class: 'btn btn--small btn--ghost',
                type: 'button',
                text: 'この状態に戻す',
                onclick: guarded(async () => {
                  const ok = await confirmDialog({
                    title: '退避したデータに戻しますか？',
                    message: 'いまのデータも自動で退避してから戻します。',
                    confirmLabel: '戻す',
                  });
                  if (!ok) return;
                  await store.restoreSnapshot(snapshot.id);
                  toast('戻しました', { tone: 'success' });
                  await refreshHash();
                }),
              }),
              el('button', {
                class: 'btn btn--small btn--ghost btn--danger-text',
                type: 'button',
                text: '削除',
                onclick: guarded(async () => {
                  const ok = await confirmDialog({ title: '退避データを削除', message: 'この退避データを削除しますか？', confirmLabel: '削除', danger: true });
                  if (!ok) return;
                  await store.deleteSnapshot(snapshot.id);
                  await refreshHash();
                }),
              }),
            ]),
          ])))
        : el('p', { class: 'muted', text: 'まだ退避データはありません（復元すると自動で作られます）。' }),
    ]),

    el('section', { class: 'card' }, [
      el('h2', { class: 'card__title', text: '家族の設定' }),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '家族の名前' }), familyName]),
      el('button', {
        class: 'btn btn--ghost btn--small',
        type: 'button',
        id: 'renameFamilyButton',
        text: '名前を変更',
        onclick: guarded(async () => {
          await store.renameFamily(familyName.value);
          toast('変更しました', { tone: 'success' });
          await refreshHash();
        }),
      }),
      el('hr', { class: 'divider' }),
      el('h3', { class: 'card__subtitle', text: 'PIN の変更' }),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'いまの PIN' }), pinCurrent]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: '新しい PIN' }), pinNext]),
      el('button', {
        class: 'btn btn--ghost btn--small',
        type: 'button',
        id: 'changePinButton',
        text: 'PIN を変更',
        onclick: guarded(async () => {
          await store.changePin({ currentPin: pinCurrent.value, newPin: pinNext.value });
          pinCurrent.value = '';
          pinNext.value = '';
          toast('PIN を変更しました', { tone: 'success' });
        }),
      }),
    ]),

    renderFamilyResetSection()
  );

  restoreFile.addEventListener('change', async () => {
    const file = restoreFile.files?.[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      restoreField.value = text;
      await runRestore(text);
    } catch (error) {
      toast(error?.message ?? '読み込めませんでした', { tone: 'error' });
    } finally {
      restoreFile.value = '';
    }
  });
}

/* ------------------------------------------------------------ 危険な操作（家族データの初期化・v29） */

/** データタブのいちばん下に置く「危険な操作」 */
function renderFamilyResetSection() {
  return el('section', { class: 'card danger-zone', id: 'dangerSection' }, [
    el('h2', { class: 'card__title', text: FACTORY_RESET_TITLE }),
    el('p', { class: 'muted small', text: FACTORY_RESET_DESCRIPTION }),
    el('ul', { class: 'danger-list' }, FACTORY_RESET_ERASED.map((label) => el('li', { text: label }))),
    el('p', { class: 'muted small', id: 'factoryResetChildNotice', text: FACTORY_RESET_CHILD_NOTICE }),
    el('button', {
      class: 'btn btn--danger',
      type: 'button',
      id: 'factoryResetButton',
      text: FACTORY_RESET_LABEL,
      onclick: guarded(() => openFamilyResetSheet()),
    }),
  ]);
}

/**
 * 初期化のシート。
 * PIN（現在の4桁）＋「もとへ もどせません」のチェック＋最終ボタン。
 *
 * v31: 実機の PWA では自動ダウンロードが黙って失敗する。そこで
 * **「バックアップを のこす」手動ステップ**（共有して保存／コピー）を置き、
 * 「保存できた」にチェックする（または「バックアップなしで つづける」を選ぶ）まで初期化させない。
 * 実行時は端末内の自動退避1件を必ずつくる（失敗したら消さない）。
 */
function openFamilyResetSheet() {
  const pinInput = el('input', { class: 'input input--pin', type: 'password', inputmode: 'numeric', maxlength: '4', id: 'resetAllPin', 'aria-label': 'PIN' });
  const childBox = el('input', { type: 'checkbox', id: 'resetAllChildren', class: 'check' });
  const confirmBox = el('input', { type: 'checkbox', id: 'resetAllConfirm', class: 'check' });
  const noBackupBox = el('input', { type: 'checkbox', id: 'resetAllNoBackup', class: 'check' });
  const savedBox = el('input', { type: 'checkbox', id: 'resetAllSaved', class: 'check', disabled: true });
  const error = el('p', { class: 'form-error', id: 'resetAllError', hidden: true });
  const status = el('p', { class: 'muted small reset-status', id: 'resetAllStatus', hidden: true });
  const shareButton = el('button', {
    class: 'btn btn--ghost btn--small',
    type: 'button',
    id: 'resetShareBackup',
    text: SAVE_STEP_SHARE,
    onclick: guarded(() => manualSave()),
  });
  const copyButton = el('button', {
    class: 'btn btn--ghost btn--small',
    type: 'button',
    id: 'resetCopyBackup',
    text: SAVE_STEP_COPY,
    onclick: guarded(() => manualSave({ copyOnly: true })),
  });

  const content = el('div', { class: 'stack' }, [
    el('p', { class: 'muted small', text: '実行すると、この端末の つぎの データが すべて 消えます。' }),
    el('ul', { class: 'danger-list' }, FACTORY_RESET_ERASED.map((label) => el('li', { text: label }))),
    el('p', { class: 'muted small', text: `${FACTORY_RESET_CHILD_NOTICE}（こどもの端末の データは きえません）。` }),
    el('section', { class: 'reset-backup', id: 'resetBackupStep' }, [
      el('h3', { class: 'card__subtitle', text: SAVE_STEP_TITLE }),
      el('p', { class: 'muted small', id: 'resetBackupNote', text: SAVE_STEP_LEAD }),
      el('div', { class: 'button-row' }, [shareButton, copyButton]),
      el('p', { class: 'muted small', text: SAVE_STEP_NOTE }),
      el('label', { class: 'check-row' }, [
        savedBox,
        el('span', { class: 'check-row__label' }, [
          el('strong', { text: SAVED_LABEL }),
          el('span', { class: 'muted small', text: SAVE_STEP_LOCKED_NOTE }),
        ]),
      ]),
    ]),
    el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'いまの PIN（4桁）' }), pinInput]),
    el('label', { class: 'check-row' }, [
      childBox,
      el('span', { class: 'check-row__label' }, [
        el('strong', { text: FACTORY_RESET_CHILD_OPTION }),
        el('span', { class: 'muted small', text: FACTORY_RESET_CHILD_NOTE }),
      ]),
    ]),
    el('label', { class: 'check-row' }, [confirmBox, el('span', { class: 'check-row__label', text: FACTORY_RESET_CONFIRM_TEXT })]),
    el('label', { class: 'check-row check-row--sub' }, [
      noBackupBox,
      el('span', { class: 'check-row__label muted small', text: NO_BACKUP_LABEL }),
    ]),
    error,
    status,
  ]);

  let cancelled = false;
  let continuing = false;
  const sheet = openSheet({
    title: '家族データを初期化',
    description: 'アプリを いれた 直後の 状態に もどします。',
    content,
    size: 'wide',
    actions: [
      { label: 'やめる', onClick: (close) => close() },
      { label: '初期化する', variant: 'danger', onClick: (close) => run(close) },
    ],
    // 実行中に閉じられたら（「やめる」・✕・Esc）消さずに中止する
    onClose: () => {
      if (!continuing) cancelled = true;
    },
  });
  const submit = sheet.root.querySelector('.sheet__foot .btn--danger');
  sheet.root.id = 'familyResetSheet';

  let busy = false;
  /** 直前の準備（バックアップ＋自動退避）。ダウンロード失敗からの再試行では作り直さない */
  let prepared = null;

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
    sheet.root.dataset.error = message;
  }

  /**
   * 手動の保存ステップ（共有して保存／コピー）。**PIN はいらない**（保存するだけ）。
   * 3段構えは通常のバックアップと同じ。実行できたら「保存できた」を押せるようにする。
   */
  async function manualSave({ copyOnly = false } = {}) {
    if (busy) return null;
    error.hidden = true;
    let text;
    try {
      text = JSON.stringify(await store.exportBackup(), null, 2);
    } catch {
      showError(BACKUP_FAILED_MESSAGE);
      return null;
    }
    const result = await saveBackupJson({ filename: store.backupFileName(), text, copyOnly });
    if (result?.ok) {
      savedBox.disabled = false;
      sheet.root.dataset.backupSaved = result.mode;
    }
    return result;
  }

  async function run(close) {
    if (busy) return;
    error.hidden = true;
    const check = validateFactoryResetInput({
      pin: pinInput.value,
      confirmed: confirmBox.checked,
      noBackup: noBackupBox.checked,
      saved: savedBox.checked,
    });
    if (!check.ok) {
      // 保存ステップの話より前に、PIN の誤りを伝える（照合だけ・データは変えない）
      if (check.message === SAVED_REQUIRED_MESSAGE) {
        const pinOk = await store.verifyPin(pinInput.value);
        if (!pinOk) {
          showError(PIN_MISMATCH_MESSAGE);
          pinInput.focus();
          return;
        }
        showError(check.message);
        savedBox.focus();
        return;
      }
      showError(check.message);
      if (check.message === CONFIRM_REQUIRED_MESSAGE) confirmBox.focus();
      else pinInput.focus();
      return;
    }

    busy = true;
    submit.disabled = true;
    submit.textContent = '初期化しています…';
    sheet.root.dataset.busy = 'true';

    try {
      if (!prepared) prepared = await store.prepareFamilyReset({ pin: pinInput.value });

      // 手動ステップで保存済みなら、二重のダウンロードはしない（端末内の自動退避は上で作っている）
      let downloaded = savedBox.checked ? 'saved' : true;
      if (savedBox.checked) {
        toast('バックアップは 保存済みです（端末内にも 自動退避を 1件 つくりました）', { tone: 'success' });
      } else {
        try {
          downloadFile(prepared.fileName, prepared.json);
        } catch {
          downloaded = false;
        }
      }
      if (downloaded === false && !noBackupBox.checked) {
        // バックアップを黙って諦めない。端末内の自動退避はできているので、明示的な選択があれば続行できる
        sheet.root.dataset.downloadBlocked = 'true';
        showError(BACKUP_DOWNLOAD_RETRY_MESSAGE);
        return;
      }

      if (cancelled) return; // 実行中に閉じられた → 消さない

      // 実測用（実行後も読めるように body に残す）
      document.body.dataset.resetBackupFile = prepared.fileName;
      document.body.dataset.resetBackupBytes = String(prepared.bytes);
      document.body.dataset.resetSnapshotCount = String(prepared.snapshotCount);
      document.body.dataset.resetBackupDownloaded = downloaded === 'saved' ? 'saved' : downloaded ? 'true' : 'false';
      status.hidden = false;
      status.textContent = `バックアップ: ${prepared.fileName}（${Math.max(1, Math.round(prepared.bytes / 1024))}KB）／端末内の自動退避 ${prepared.snapshotCount}件`;

      // こどもの初期化QRは「家族の鍵が消える前」に発行する（順序を守る）
      const qrItems = childBox.checked ? await buildChildFactoryResetQrs() : [];
      if (cancelled) return; // QRの準備中に閉じられた → 消さない

      continuing = true;
      close();
      if (qrItems.length) await showChildFactoryResetQrs(qrItems);

      await store.factoryReset();
      document.body.dataset.resetDone = 'true';
      closeAllSheets();
      await resetToFactoryUi();
      toast(FACTORY_RESET_DONE_TOAST, { tone: 'success' });
    } catch (error) {
      sheet.root.dataset.error = error?.message || 'unknown';
      showError(error?.message || FACTORY_RESET_FAILED_MESSAGE);
    } finally {
      busy = false;
      sheet.root.dataset.busy = 'false';
      if (sheet.root.isConnected) {
        submit.disabled = false;
        submit.textContent = '初期化する';
      }
    }
  }
  setTimeout(() => pinInput.focus(), 80);
  return sheet;
}

/** こども全員ぶんの初期化QR（完全初期化＝factory）を、消す前に発行する */
async function buildChildFactoryResetQrs() {
  const children = await store.listChildren();
  const items = [];
  for (const child of children) {
    const result = await store.buildResetQr(child.id, 'factory');
    result.qrs.forEach((qr, index) => {
      items.push({ qr, label: result.qrs.length > 1 ? `${child.name} の端末用（完全初期化・${index + 1}枚目）` : `${child.name} の端末用（完全初期化）` });
    });
  }
  return items;
}

/** QR を出して、閉じられるまで待つ（閉じたら初期化を進める） */
function showChildFactoryResetQrs(items) {
  return new Promise((resolve) => {
    showQrSheet({
      title: 'こどもの端末の初期化QR',
      description: 'いま 出ている QR を、こどもの端末で 読み取ってください。読み取ると こどもの端末は 完全初期化されます。',
      qrs: items.map((item) => item.qr),
      labels: items.map((item) => item.label),
      note: 'この画面を とじると、家族データの 初期化を つづけます。QRは 家族の かぎが きえる前に つくっています。',
      actions: [{ label: 'とじて 初期化を つづける', variant: 'danger', onClick: (close) => close() }],
      onClose: () => resolve(),
    });
  });
}

/** 初期化の直後：メモリ上の家族も捨ててから、家族未作成のセットアップ画面へ */
function resetToFactoryUi() {
  currentFamily = null;
  unlockedFamilyId = null;
  window.onhashchange = null;
  if (location.hash && location.hash !== '#/') location.hash = '#/';
  return initParentScreen();
}

async function runRestore(text) {
  const ok = await confirmDialog({
    title: 'バックアップから復元しますか？',
    message: 'いまのデータは自動で退避してから復元します。よろしいですか？',
    confirmLabel: '復元する',
  });
  if (!ok) return;
  const result = await store.restoreBackup(text);
  openSheet({
    title: '復元しました',
    content: el('div', { class: 'stack' }, [
      el('p', { text: `復元したデータ: ${result.restored}件` }),
      el('p', { text: `復元前のデータ: ${result.replaced}件（自動退避しました）` }),
      el('p', { class: 'muted small', text: '「データ」タブの「自動退避」から、復元前の状態に戻せます。' }),
    ]),
  });
  await refreshHash();
}

async function refreshHash() {
  const family = await store.getFamily();
  if (family) await renderApp(family);
}
