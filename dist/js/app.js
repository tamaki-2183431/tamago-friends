/** アプリ起動（画面の振り分けと Service Worker 登録） */
import { initChildScreen } from './ui/child.js';
import { initParentScreen } from './ui/parent.js';

const page = document.body.dataset.page;
const boot = page === 'parent' ? initParentScreen : initChildScreen;

boot().catch((error) => {
  console.error(error);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<p style="padding:16px;color:#c93a4b">起動に失敗しました: ${String(error?.message ?? error)}</p>`
  );
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
