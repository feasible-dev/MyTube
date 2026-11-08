import { createElementFactory } from './dom.mjs';
import { videoUrl, durationLabel } from './model.mjs';
import { validChannelAvatar } from '../extension/channel-avatar.mjs';
import { validVideoThumbnail } from '../extension/video-thumbnail.mjs';

// Rendering depends only on public video data and explicit UI actions.
export function renderVideoCard(document, v, { saved, persistent, thumbnail, knownDuration, onSave, onHide, onBan }) {
  const element = createElementFactory(document);
  thumbnail ??= validVideoThumbnail(v.thumbnail_url, v.platform) ? v.thumbnail_url : undefined;
  function youtubeLink(v, className) {
    const link = element('a', className);
    link.href = videoUrl(v.video_id); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
    return link;
  }
  const article = element('article', `video-card${v.discovery_stream === 'wildcard' ? ' is-wildcard' : ''}`);
  article.setAttribute('data-video-id', v.video_id);
  const cover = youtubeLink(v, 'cover'); cover.setAttribute('aria-label', `Watch ${v.title} on ${v.platform ?? 'YouTube'}`);
  if (thumbnail || ['youtube_live', 'youtube_web'].includes(v.source)) {
    const img = element('img'); img.alt = ''; img.loading = 'lazy'; img.width = 480; img.height = 360; img.referrerPolicy = 'no-referrer';
    cover.classList.add('is-loading');
    let settled = false;
    const finish = failed => {
      if (settled) return;
      settled = true; cover.classList.remove('is-loading');
      if (failed) { img.remove(); cover.append(element('span', 'cover-placeholder', 'Thumbnail unavailable')); }
    };
    img.addEventListener('load', () => finish(false), { once: true });
    img.addEventListener('error', () => finish(true), { once: true });
    img.src = thumbnail ?? `https://i.ytimg.com/vi/${v.video_id}/mqdefault.jpg`;
    cover.append(img);
    if (img.complete) finish(img.naturalWidth === 0);
  } else cover.append(element('span', 'cover-placeholder', v.preview_unavailable ? 'Video unavailable on provider' : v.platform ?? 'YOUTUBE'));
  const duration = v.duration_seconds ?? knownDuration;
  if (Number.isFinite(duration) && duration > 0) cover.append(element('span', 'duration-badge', durationLabel(duration)));
  const body = element('div', 'card-body'), channel = element('div', 'channel-line');
  const avatar = element('span', 'channel-avatar', v.channel.trim().slice(0, 1).toUpperCase());
  avatar.setAttribute('aria-hidden', 'true');
  if (validChannelAvatar(v.channel_avatar)) {
    const image = element('img'); image.alt = ''; image.width = 22; image.height = 22;
    image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = v.channel_avatar; avatar.append(image);
  }
  const channelName = element('span', 'channel-name', v.channel); channelName.title = v.channel;
  channel.append(avatar, channelName);
  const heading = element('h4', 'video-title'), title = youtubeLink(v); title.textContent = v.title; heading.append(title);
  title.title = v.title;
  const year = /^\d{4}/.exec(v.published_at ?? '')?.[0] ?? 'Date unavailable';
  const views = Number.isSafeInteger(v.views) ? `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v.views)} views` : 'Views unavailable';
  const meta = element('p', 'card-meta', ['youtube_web', 'external_web'].includes(v.source) ? '' : `${year} · ${views}`);
  meta.title = `${v.published_at?.slice(0, 10) ?? 'Date unavailable'} · ${Number.isSafeInteger(v.views) ? v.views.toLocaleString('en') + ' views at collection' : 'Views unavailable'}`;
  const utility = element('div', 'utility-actions');
  const save = element('button', 'outline-button save-video', saved ? 'Saved' : 'Save for later');
  save.type = 'button'; save.setAttribute('aria-pressed', String(saved));
  save.setAttribute('aria-label', `${saved ? 'Unsave' : 'Save'} ${v.title}`); save.title = persistent ? 'Bookmark in MyTube on this device. No video download.' : 'Bookmark in MyTube for this session. No video download.';
  save.addEventListener('click', () => {
    saved = onSave(v);
    save.classList.toggle('saved', saved);
    save.textContent = saved ? 'Saved' : 'Save for later';
    save.setAttribute('aria-pressed', String(saved));
    save.setAttribute('aria-label', `${saved ? 'Unsave' : 'Save'} ${v.title}`);
  });
  const hide = element('button', 'outline-button hide-video', 'Hide'); hide.title = 'Hide this video'; hide.setAttribute('aria-label', `Hide ${v.title}`);
  hide.addEventListener('click', () => onHide(v));
  utility.append(hide);
  let ban;
  if (v.source !== 'external_web') {
    ban = element('button', 'outline-button ban-channel', 'Ban channel');
    ban.title = `Never show ${v.channel} again`; ban.setAttribute('aria-label', `Ban channel ${v.channel}`);
    ban.addEventListener('click', () => onBan(v));
  }
  utility.prepend(save);
  body.append(heading, channel);
  if (meta.textContent) body.append(meta);
  const detailsRow = element('div', 'card-details'); if (ban) detailsRow.append(ban); detailsRow.append(utility);
  article.append(cover, body, detailsRow); return article;
}
