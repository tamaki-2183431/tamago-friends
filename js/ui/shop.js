/**
 * ショップ（Phase 3-2）。
 *
 * - 部屋から開く。カテゴリは すわる／おく／ねる／かざる／みどり／じゅうたん／かべとゆか／ぼうし
 * - 価格は 20 / 40 / 60 / 100 の4帯だけ（コインの獲得手段は増やさない）
 * - 所持済みは「もっている」で再購入できない
 * - 買った家具は「おく」で部屋に出せる（置いた家具はドラッグで移動）
 * - 壁紙・床は買った中から1つを選んで切り替える
 */

import * as childStore from '../store/child.js';
import { CATEGORIES, DEFAULT_FLOOR, DEFAULT_WALLPAPER, findShopItem, itemsByCategory, isPlaceable } from '../../data/shop.js';
import { paintFurniture, paintSurfaceSwatch } from './furniture-art.js';
import { drawHatThumb } from './pet-accessory.js';
import { clear, el, formatNumber, guarded, mount, openSheet, toast } from './dom.js';

/** 品物のサムネ（家具・もようがえ・帽子で描き方を変える） */
function thumbFor(item, size = 44) {
  const canvas = el('canvas', { class: 'shop-item__art' });
  if (item.surface) paintSurfaceSwatch(canvas, item, { size });
  else if (item.category === 'hat') drawHatThumb(canvas, item, { size });
  else paintFurniture(canvas, item, { maxWidth: size, maxHeight: size });
  return canvas;
}

/**
 * カードに出す「あと Xまい」（v26）。
 *
 * 押す前に不足が分かるように、**未所持で かう 対象の家具**が
 * 残高より高いときだけ返す。次のときは出さない（仕様）:
 * - 所持済み・配置済み（そもそも「かう」ではない）
 * - ぼうし（`hat`）・かべとゆか（`surface`）
 * - むりょう（price 0）・価格を持たない所持品（ごはんばち・ボール）
 *
 * 記号や文言はここ1か所（カードの本文と `aria-label` で同じ数字を使う）。
 * @param {object} item ショップの商品
 * @param {{owned?: boolean, placed?: boolean, balance?: number}} state
 * @returns {{shortfall:number, text:string, ariaLabel:string}|null} 足りていれば null
 */
export function shopShortfall(item, { owned = false, placed = false, balance = 0 } = {}) {
  if (!item || owned || placed) return null;
  if (item.surface) return null;
  if (item.category === 'hat') return null;
  if (typeof item.price !== 'number' || item.price <= 0) return null;
  const rest = Math.round(item.price) - Math.max(0, Math.round(Number(balance) || 0));
  if (rest <= 0) return null;
  const amount = formatNumber(rest);
  return { shortfall: rest, text: `あと ${amount}まい`, ariaLabel: `かう（あと ${amount}まい たりない）` };
}

/**
 * ショップを開く。
 * @param {{onChanged?: (room:object)=>void}} options
 */
export async function openShopSheet({ onChanged = null } = {}) {
  const petCount = (await childStore.listPets()).length;
  let room = await childStore.getRoom({ petCount });
  let coins = await childStore.getCoins();
  let category = 'decor';

  const grid = el('div', { class: 'shop__grid', id: 'shopGrid' });
  const balance = el('p', { class: 'shop__balance', id: 'shopBalance', 'aria-live': 'polite' });
  const tabs = el('div', { class: 'shop__tabs', role: 'tablist', 'aria-label': 'カテゴリ' });

  const paintBalance = () => {
    balance.textContent = `🪙 ${formatNumber(coins?.balance ?? 0)}まい`;
  };

  const activeSurface = (item) => {
    if (item.surface === 'wallpaper') return room.wallpaper === item.id;
    if (item.surface === 'floor') return room.floor === item.id;
    return false;
  };

  const refreshState = async () => {
    room = await childStore.getRoom({ petCount });
    coins = await childStore.getCoins();
    paintBalance();
    onChanged?.(room);
  };

  /** 1つの商品カード */
  function card(item) {
    const owned = room.inventory.includes(item.id);
    const placed = room.furniture.some((entry) => entry.itemId === item.id);
    const isSurface = Boolean(item.surface);
    const active = activeSurface(item);
    // 押す前の不足表示（残高が変わったら render() ごとに作り直す）
    const short = shopShortfall(item, { owned, placed, balance: coins?.balance ?? 0 });

    let actionLabel;
    let actionTone = 'primary';
    let disabled = false;
    let onClick = null;

    if (!owned) {
      actionLabel = 'かう';
      onClick = guarded(async () => {
        const result = await childStore.purchaseItem(item.id, Date.now());
        if (!result.ok) {
          if (result.reason === 'coins') {
            toast(`コインが たりないよ（あと ${formatNumber(result.shortfall)}まい）`, { tone: 'error', duration: 2800 });
          } else if (result.reason === 'owned') {
            toast('もう もっているよ', { tone: 'info' });
          } else {
            toast('いまは かえないよ', { tone: 'error' });
          }
          return;
        }
        await refreshState();
        render();
        toast(`${item.name}を かったよ！`, { tone: 'success', duration: 2200 });
      });
    } else if (isSurface) {
      actionLabel = active ? 'つかってる' : 'つかう';
      actionTone = active ? 'ghost' : 'primary';
      disabled = active;
      onClick = guarded(async () => {
        const result = await childStore.setSurface(item.surface, item.id);
        if (!result.ok) {
          toast('いまは きりかえられないよ', { tone: 'error' });
          return;
        }
        await refreshState();
        render();
        toast(`${item.name}に したよ`, { tone: 'success', duration: 1800 });
      });
    } else if (item.category === 'hat') {
      actionLabel = 'もっている';
      actionTone = 'ghost';
      disabled = true;
    } else if (isPlaceable(item)) {
      actionLabel = placed ? 'おいてある' : 'おく';
      actionTone = placed ? 'ghost' : 'primary';
      disabled = placed;
      onClick = guarded(async () => {
        const result = await childStore.placeItem(item.id, { now: Date.now() });
        if (!result.ok) {
          toast(result.reason === 'no-space' ? 'おく ところが ないよ。なにか かたづけてね' : 'おけなかったよ', { tone: 'error', duration: 2600 });
          return;
        }
        await refreshState();
        render();
        toast(`${item.name}を おいたよ（ドラッグで うごかせるよ）`, { tone: 'success', duration: 2400 });
      });
    } else {
      actionLabel = 'もっている';
      actionTone = 'ghost';
      disabled = true;
    }

    const meta = item.price === 0 ? 'むりょう' : `🪙 ${formatNumber(item.price)}`;
    return el('article', { class: `shop-item${owned ? ' shop-item--owned' : ''}`, dataset: { itemId: item.id, category: item.category } }, [
      el('div', { class: 'shop-item__thumb' }, [thumbFor(item)]),
      el('div', { class: 'shop-item__body' }, [
        el('p', { class: 'shop-item__name', text: item.name }),
        el('p', { class: 'shop-item__meta' }, [
          el('span', { class: 'shop-item__price', text: meta }),
          el('span', { class: 'shop-item__dot', text: '・' }),
          el('span', { class: 'shop-item__owned', text: `もちもの ${owned ? 1 : 0}` }),
        ]),
        short ? el('p', { class: 'shop-item__short', text: short.text }) : null,
        item.note ? el('p', { class: 'shop-item__note', text: item.note }) : null,
      ]),
      el('button', {
        class: `btn btn--${actionTone} btn--small shop-item__action`,
        type: 'button',
        dataset: { action: actionLabel },
        'aria-label': short?.ariaLabel,
        disabled,
        text: actionLabel,
        onclick: onClick,
      }),
    ]);
  }

  function render() {
    clear(tabs);
    for (const entry of CATEGORIES) {
      tabs.append(el('button', {
        class: `shop__tab${entry.id === category ? ' shop__tab--on' : ''}`,
        type: 'button',
        role: 'tab',
        'aria-selected': entry.id === category ? 'true' : 'false',
        dataset: { category: entry.id },
        text: entry.label,
        onclick: guarded(() => {
          category = entry.id;
          render();
        }),
      }));
    }

    clear(grid);
    const items = itemsByCategory(category);
    for (const item of items) grid.append(card(item));

    // かべとゆかは「もとにもどす」も選べる
    if (category === 'surface') {
      const hasWall = room.wallpaper !== DEFAULT_WALLPAPER;
      const hasFloor = room.floor !== DEFAULT_FLOOR;
      if (hasWall || hasFloor) {
        grid.append(el('button', {
          class: 'btn btn--ghost btn--small shop__reset',
          type: 'button',
          id: 'shopResetSurface',
          text: 'もとの かべ・ゆかに もどす',
          onclick: guarded(async () => {
            if (hasWall) await childStore.setSurface('wallpaper', DEFAULT_WALLPAPER);
            if (hasFloor) await childStore.setSurface('floor', DEFAULT_FLOOR);
            await refreshState();
            render();
            toast('もとの もように もどしたよ', { tone: 'info', duration: 1800 });
          }),
        }));
      }
    }
    paintBalance();
  }

  const sheet = openSheet({
    title: 'ショップ',
    description: 'コインで かぐや もようがえを かおう。かった かぐは へやに おけるよ。',
    content: el('div', { class: 'shop' }, [
      el('div', { class: 'shop__head' }, [balance]),
      tabs,
      grid,
      el('p', { class: 'shop__note muted small', text: 'コインは ふか +30 / そだち +50 / おせわ で ふえるよ。' }),
    ]),
    onClose: () => onChanged?.(room),
  });

  render();
  return sheet;
}
