/* storage-usage-settings.js - R247 (0429, FILE-04): the "File storage" card in Settings -> General. A meter of how full the
   studio's file storage is (photos, files, voice notes) against its quota, and the split per kind. Reads ONLY through
   BPStore.storageUsage.get() (storage_usage(): Settings view, numbers only - never a file name). Hidden on a database
   without 0429 or for people without Settings access. DOM API only (textContent, no HTML strings). */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var $ = function (id) { return document.getElementById(id); };
  var started = false, tries = 0;

  function size(b) {
    var n = Number(b) || 0;
    if (n >= 1073741824) return (Math.round(n / 107374182.4) / 10) + " GB";
    if (n >= 1048576) return Math.round(n / 1048576) + " MB";
    if (n >= 1024) return Math.round(n / 1024) + " KB";
    return n + " bytes";
  }
  function paint(u, labels) {
    var pct = Math.max(0, Math.min(100, Number(u.pct) || 0)), warn = Number(u.warn_pct) || 80;
    var m = $("sto_meter"), f = $("sto_fill");
    f.style.width = pct + "%";
    m.setAttribute("aria-valuenow", String(Math.round(pct)));
    m.classList.toggle("warn", pct >= warn && pct < 100);
    m.classList.toggle("full", pct >= 100);
    var line = size(u.used_bytes) + " of " + size(u.quota_bytes) + " used (" + (Math.round(pct * 10) / 10) + "%), "
      + (Number(u.files) || 0).toLocaleString("en-IN") + " file" + (Number(u.files) === 1 ? "" : "s") + ".";
    if (pct >= 100) line += " Storage is full - new uploads are refused. Delete old files or ask Helm to raise the limit.";
    else if (pct >= warn) line += " Storage is almost full. Delete old files or ask Helm to raise the limit.";
    $("sto_line").textContent = line;
    var list = $("sto_list"); list.textContent = "";
    (Array.isArray(u.buckets) ? u.buckets : []).forEach(function (b) {
      if (!b || !(Number(b.files) > 0)) return;
      var li = document.createElement("li");
      li.textContent = (labels[b.bucket] || "Other files") + ": " + size(b.bytes) + " (" + (Number(b.files) || 0).toLocaleString("en-IN") + ")";
      list.appendChild(li);
    });
  }
  async function init() {
    if (started) return;
    var card = $("stoCard"); if (!card) return;
    var B = global.BPStore;
    if (!B || !B.storageUsage || !B.auth || !B.auth.user || !B.auth.user()) { if (++tries < 30) setTimeout(init, 1000); return; }
    started = true;
    var u = null;
    try { u = await B.storageUsage.get(); } catch (e) { u = null; }
    if (!u || u.quota_bytes == null) return;          // older database / no access: keep hidden
    card.hidden = false; paint(u, B.storageUsage.LABELS || {});
  }
  global.HelmStorageUsage = { init: init, _size: size };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(init, 600); });
  else setTimeout(init, 600);
})(typeof window !== "undefined" ? window : globalThis);
