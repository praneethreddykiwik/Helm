/* =========================================================================
   HelmLayoutStock (R248, 0430) - the products of the 2D / 3D floor plan on the
   Inventory page: for each upcoming event, per stock item
     In layout   how many the latest floor plan needs (linked layout products)
     Reserved    what the event already holds (reserved or out)
     Free that day  what is still free on its stock days (Helm counts by DAY)
     To borrow   the rest - rent from a vendor / buy / leave unsourced
   plus "Same day as <event>" when another event on the same stock days holds or
   needs the same item, and the links (layout product -> stock item).
   Numbers come from the server (layout_stock_needs / layout_stock_overview).
   Reserving uses the existing reserve_inventory_with_sourcing, after a confirm.
   Pure helpers are unit-tested (Node: require()); the DOM part builds nodes only
   (createElement / textContent, no HTML strings, no inline styles - CSP).
   ========================================================================= */
(function (root) {
  "use strict";

  var CATS = { structure: "Structure", seating: "Seating", av: "AV & Stage", security: "Security", logistics: "Logistics", safety: "Safety", decor: "Decor" };
  var CAT_ORDER = ["seating", "structure", "av", "decor", "logistics", "security", "safety"];
  var HIDE_KEY = "helm.r248.notStock";
  var RANGES = [7, 14, 30, 60, 90];

  function n(x) { var v = Number(x); return isFinite(v) ? v : 0; }
  function fmt(x) { return Math.round(n(x)).toLocaleString("en-IN"); }
  function catName(k) { k = String(k || "").toLowerCase(); return CATS[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "Other"); }
  function typeLabel(t, label) {
    if (label && String(label).trim()) return String(label).trim();
    var s = String(t || ""); return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Layout product";
  }
  // YYYY-MM-DD + k days (calendar days, no time zone shift)
  function addDays(ymd, k) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || "")); if (!m) return null;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + (Math.trunc(n(k)))));
    return d.toISOString().slice(0, 10);
  }
  // one item line -> the numbers the page shows
  function rowNums(it) {
    it = it || {};
    var needed = Math.max(n(it.needed), 0), held = Math.max(n(it.held), 0), free = Math.max(n(it.free), 0);
    var toReserve = it.to_reserve != null ? Math.max(n(it.to_reserve), 0) : Math.max(needed - held, 0);
    var toBorrow = it.to_borrow != null ? Math.max(n(it.to_borrow), 0) : Math.max(needed - held - free, 0);
    var shared = it.to_borrow_shared != null ? Math.max(n(it.to_borrow_shared), 0) : toBorrow;
    return { needed: needed, held: held, free: free, toReserve: toReserve, toBorrow: toBorrow, toBorrowShared: shared,
      short: toBorrow > 0, sharedShort: shared > toBorrow, covered: needed > 0 && toReserve === 0 };
  }
  // the item lines of one event block, grouped by the floor-plan category of their first layout product
  function groupItems(block) {
    var typeCat = {}, typeLbl = {};
    ((block && block.types) || []).forEach(function (t) { typeCat[t.layout_type] = t.category; typeLbl[t.layout_type] = typeLabel(t.layout_type, t.label); });
    var groups = {};
    ((block && block.items) || []).forEach(function (it) {
      var types = (Array.isArray(it.types) ? it.types.slice() : []).sort();
      var key = String((types.length && typeCat[types[0]]) || "").toLowerCase() || "other";
      (groups[key] = groups[key] || []).push(Object.assign({}, it, { from: types.map(function (t) { return typeLbl[t] || typeLabel(t); }) }));
    });
    return Object.keys(groups).sort(function (a, b) {
      var ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b); ia = ia < 0 ? 99 : ia; ib = ib < 0 ? 99 : ib;
      return ia - ib || a.localeCompare(b);
    }).map(function (k) {
      return { key: k, name: catName(k === "other" ? "" : k), items: groups[k].sort(function (a, b) { return String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" }); }) };
    });
  }
  // what "Reserve from layout" will do: per item, how many to reserve, how many come from stock now, how many are short
  function reservePlan(block) {
    var lines = ((block && block.items) || []).filter(function (it) { return it && it.active !== false; }).map(function (it) {
      var r = rowNums(it), fromStock = Math.min(r.toReserve, Math.floor(r.free));
      return { item_id: it.item_id, name: it.name || "Item", unit: it.unit || "", qty: Math.ceil(r.toReserve), fromStock: Math.max(fromStock, 0), short: Math.max(Math.ceil(r.toReserve) - Math.max(fromStock, 0), 0) };
    }).filter(function (l) { return l.qty > 0 && l.item_id; });
    return { lines: lines, qty: lines.reduce(function (a, l) { return a + l.qty; }, 0),
      fromStock: lines.reduce(function (a, l) { return a + l.fromStock; }, 0), short: lines.reduce(function (a, l) { return a + l.short; }, 0) };
  }
  // "Same day as Rao Rally" / "... and Gala" / "... + 2 more"
  function sameDayText(list) {
    var names = []; (list || []).forEach(function (s) { var t = String((s && s.event) || "").trim() || "another event"; if (names.indexOf(t) < 0) names.push(t); });
    if (!names.length) return "";
    if (names.length === 1) return "Same day as " + names[0];
    if (names.length === 2) return "Same day as " + names[0] + " and " + names[1];
    return "Same day as " + names[0] + " + " + (names.length - 1) + " more";
  }
  // the layout products of the upcoming events that are not linked to stock yet (one line per type)
  function unlinkedAll(overview, hidden) {
    var hid = hidden || {}, map = {};
    ((overview && overview.events) || []).forEach(function (ev) {
      (ev.unlinked || []).forEach(function (u) {
        if (!u || !u.layout_type || hid[u.layout_type]) return;
        var m = map[u.layout_type] || (map[u.layout_type] = { layout_type: u.layout_type, label: typeLabel(u.layout_type, u.label), category: u.category || "", objects: 0, seats: 0, events: 0 });
        m.objects += n(u.objects); m.seats += n(u.seats); m.events += 1;
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) {
      var ia = CAT_ORDER.indexOf(String(a.category).toLowerCase()), ib = CAT_ORDER.indexOf(String(b.category).toLowerCase()); ia = ia < 0 ? 99 : ia; ib = ib < 0 ? 99 : ib;
      return ia - ib || a.label.localeCompare(b.label);
    });
  }
  // the top strip: Items, Units owned, Out now, Upcoming events short (null = not known yet)
  function strip(items, checkouts, overview) {
    var act = (items || []).filter(function (i) { return i && i.active !== false; });
    var out = (checkouts || []).reduce(function (a, c) {
      if (!c || (c.status !== "out" && c.status !== "partial")) return a;
      return a + Math.max(n(c.qty_out) - n(c.qty_in) - Math.max(n(c.written_off) - n(c.qty_damaged), 0), 0);
    }, 0);
    return { items: act.length, units: act.reduce(function (a, i) { return a + Math.max(n(i.total_qty), 0); }, 0), outNow: out,
      eventsShort: overview && overview.summary ? n(overview.summary.events_short) : null };
  }
  function shortOnly(events) { return (events || []).filter(function (e) { return n(e.short_items) > 0 || n(e.shared_items) > 0; }); }

  var api = { CATS: CATS, RANGES: RANGES, catName: catName, typeLabel: typeLabel, addDays: addDays, rowNums: rowNums, groupItems: groupItems,
    reservePlan: reservePlan, sameDayText: sameDayText, unlinkedAll: unlinkedAll, strip: strip, shortOnly: shortOnly, fmt: fmt };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }

  /* ------------------------------------------------------------------ DOM (browser only) */
  var doc = root.document;
  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === null || v === undefined || v === false) return;
      if (k === "text") el.textContent = String(v); else if (k === "cls") el.className = v; else el.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return el;
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function $(id) { return doc.getElementById(id); }
  function toast(msg, type) { try { root.BPUI.toast(msg, { type: type || "info" }); } catch (e) {} }
  function friendly(e, action) { try { return root.BPUI.friendlyError(e, { action: action }); } catch (x) { return (e && e.message) || "Something went wrong."; } }
  function optName(s) { try { if (root.BPStore && typeof root.BPStore.sampleName === "function") return root.BPStore.sampleName(s); } catch (e) {} return String(s == null ? "" : s); }
  function readHidden() { try { var v = JSON.parse(root.localStorage.getItem(HIDE_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; } }
  function writeHidden(o) { try { root.localStorage.setItem(HIDE_KEY, JSON.stringify(o || {})); } catch (e) {} }
  function today() { try { var t = root.BPStore.todayLocal(); if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t; } catch (e) {} return new Date().toISOString().slice(0, 10); }

  var S = { o: null, quoteId: null, canEdit: false, overview: null, links: [], days: 30, shortOnly: false, hidden: readHidden(), available: null, busy: false };

  function fmtDate(d) { try { return S.o && S.o.fmtDate ? S.o.fmtDate(d) : String(d || ""); } catch (e) { return String(d || ""); } }
  function dateText(b) {
    if (!b || !b.from) return b && b.event_date ? fmtDate(b.event_date) : "No date yet";
    return b.to && b.to !== b.from ? fmtDate(b.from) + " - " + fmtDate(b.to) : fmtDate(b.from);
  }
  var STATUS = { confirmed: "Confirmed", quote: "Quote", draft: "Draft", sent: "Sent", approved: "Approved" };

  // one event's numbers as a table (grouped by floor-plan category); mobile = one block per item (CSS)
  function needsTable(block) {
    var groups = groupItems(block);
    if (!groups.length) return null;
    var tb = h("tbody");
    groups.forEach(function (g) {
      tb.appendChild(h("tr", { cls: "ls-cat" }, [h("td", { colspan: "5", text: g.name })]));
      g.items.forEach(function (it) {
        var r = rowNums(it), sd = sameDayText(it.same_day);
        var nameCell = h("td", { cls: "ls-name", "data-label": "Item" }, [
          h("span", { cls: "ls-iname", text: optName(it.name) }),
          it.from && it.from.length ? h("span", { cls: "ls-from", text: "From " + it.from.join(", ") }) : null,
          (sd || r.sharedShort) ? h("span", { cls: "ls-chips" }, [
            sd ? h("span", { cls: "ls-chip same", text: sd, title: "Helm counts stock by day: these events use the same units on the same days." }) : null,
            r.sharedShort ? h("span", { cls: "ls-chip amber", text: "Short " + fmt(r.toBorrowShared) + " if all go ahead" }) : null]) : null,
          it.active === false ? h("span", { cls: "ls-chip", text: "Item switched off" }) : null]);
        tb.appendChild(h("tr", { cls: r.short ? "ls-short" : "" }, [
          nameCell,
          h("td", { cls: "num", "data-label": "In layout", text: fmt(r.needed) + (it.unit ? " " + it.unit : "") }),
          h("td", { cls: "num", "data-label": "Reserved", text: r.held ? fmt(r.held) : "-" }),
          h("td", { cls: "num", "data-label": "Free that day", text: fmt(r.free) }),
          h("td", { cls: "num", "data-label": "To borrow" }, [r.short ? h("span", { cls: "ls-chip red", text: "Short " + fmt(r.toBorrow) }) : h("span", { cls: "ls-ok", text: r.covered ? "Covered" : "-" })])]));
      });
    });
    return h("div", { cls: "table-scroll ls-scroll" }, [h("table", { cls: "ls-tbl" }, [
      h("thead", {}, [h("tr", {}, [h("th", { scope: "col", text: "Item" }), h("th", { scope: "col", cls: "num", text: "In layout" }),
        h("th", { scope: "col", cls: "num", text: "Reserved" }), h("th", { scope: "col", cls: "num", text: "Free that day" }), h("th", { scope: "col", cls: "num", text: "To borrow" })])]),
      tb])]);
  }
  function unlinkedNote(block, inPanel) {
    var u = ((block && block.unlinked) || []).filter(function (x) { return !S.hidden[x.layout_type]; });
    if (!u.length) return null;
    var names = u.slice(0, 4).map(function (x) { return typeLabel(x.layout_type, x.label); }).join(", ") + (u.length > 4 ? " + " + (u.length - 4) + " more" : "");
    var a = inPanel ? h("a", { href: "inventory.html?tab=layout#lsLinks", cls: "ls-link", text: "Link them" })
                    : h("button", { type: "button", cls: "ls-linkbtn", text: "Link them", "data-ls-goto": "links" });
    return h("p", { cls: "ls-unlinked" }, [u.length + " layout product" + (u.length === 1 ? " is" : "s are") + " not linked to stock yet: " + names + ". ", a]);
  }
  function blockBody(block, inPanel) {
    var kids = [], tbl = needsTable(block);
    if (tbl) kids.push(tbl);
    else if (n(block.objects) === 0) kids.push(h("p", { cls: "ls-empty", text: "The floor plan of this event is empty." }));
    else kids.push(h("p", { cls: "ls-empty", text: "None of the products in this floor plan is linked to a stock item yet." }));
    var un = unlinkedNote(block, inPanel); if (un) kids.push(un);
    var plan = reservePlan(block), acts = h("div", { cls: "ls-acts" });
    if (S.canEdit && plan.qty > 0) {
      var b = h("button", { type: "button", cls: "btn primary sm", text: "Reserve from layout" });
      b.addEventListener("click", function () { reserveFlow(block, b); });
      acts.appendChild(b);
    }
    if (!inPanel) acts.appendChild(h("a", { cls: "btn sm", href: "inventory.html?quote=" + encodeURIComponent(block.quote_id), text: "Open event stock" }));
    if (acts.firstChild) kids.push(acts);
    return kids;
  }
  function eventCard(b) {
    var chips = h("div", { cls: "ls-chips" });
    if (n(b.short_items) > 0) chips.appendChild(h("span", { cls: "ls-chip red", text: "Short " + fmt(b.short_items) + " item" + (n(b.short_items) === 1 ? "" : "s") }));
    var sdAll = []; (b.items || []).forEach(function (it) { (it.same_day || []).forEach(function (s) { sdAll.push(s); }); });
    var sd = sameDayText(sdAll); if (sd) chips.appendChild(h("span", { cls: "ls-chip same", text: sd }));
    if (!n(b.short_items) && (b.items || []).length && reservePlan(b).qty === 0) chips.appendChild(h("span", { cls: "ls-chip green", text: "All reserved" }));
    var st = STATUS[String(b.status || "").toLowerCase()] || "";
    return h("article", { cls: "ls-ev" + (n(b.short_items) > 0 ? " is-short" : "") }, [
      h("header", { cls: "ls-ev-h" }, [
        h("div", {}, [h("h3", { text: b.title || b.code || "Event" }), h("p", { cls: "ls-sub", text: dateText(b) + (st ? " · " + st : "") + (n(b.objects) ? " · " + fmt(b.objects) + " objects in the floor plan" : "") })]),
        chips])].concat(blockBody(b, false)));
  }

  // loading: an event card in the final shape (title line, chips, a few table rows) - no lone spinner
  function skeletonCard() {
    var tb = h("tbody");
    for (var k = 0; k < 3; k++) tb.appendChild(h("tr", { cls: "sk-row" }, [h("td", {}, [h("span", { cls: "sk w60" })]), h("td", {}, [h("span", { cls: "sk w40 skr" })]),
      h("td", {}, [h("span", { cls: "sk w40 skr" })]), h("td", {}, [h("span", { cls: "sk w40 skr" })]), h("td", {}, [h("span", { cls: "sk w40 skr" })])]));
    return h("div", { cls: "ls-skcard", "aria-busy": "true", "aria-label": "Loading" }, [h("article", { cls: "ls-ev", "aria-hidden": "true" }, [
      h("header", { cls: "ls-ev-h" }, [h("div", {}, [h("span", { cls: "sk w60" })]), h("span", { cls: "sk w20" })]),
      h("table", { cls: "ls-tbl" }, [tb])])]);
  }

  /* ---- the From layouts tab ---- */
  function renderTab() {
    var host = $("lsEvents"); if (!host) return;
    clear(host);
    var ov = S.overview;
    if (!ov) { host.appendChild(skeletonCard()); return; }
    var list = S.shortOnly ? shortOnly(ov.events) : (ov.events || []);
    var badge = $("lsTabBadge");
    if (badge) { var k = n(ov.summary && ov.summary.events_short); badge.hidden = !k; badge.textContent = k ? String(k) : ""; }
    var sum = $("lsSum");
    if (sum) sum.textContent = fmt(ov.summary.events) + " event" + (n(ov.summary.events) === 1 ? "" : "s") + " with a floor plan · " + fmt(ov.summary.events_short) + " short"
      + (n(ov.summary.events_shared) ? " · " + fmt(ov.summary.events_shared) + " sharing stock on the same day" : "") + (ov.more ? " · showing the first 60" : "");
    if (!list.length) {
      host.appendChild(h("p", { cls: "empty", text: S.shortOnly ? "Nothing is short in this period." : "No events with a floor plan in the next " + S.days + " days. Floor plans are drawn in the 2D / 3D layout of an event." }));
    } else list.forEach(function (b) { host.appendChild(eventCard(b)); });
    renderLinks();
  }

  function itemOptions(sel, withCreate) {
    var items = ((S.o && S.o.items && S.o.items()) || []).filter(function (i) { return i && i.active !== false; })
      .sort(function (a, b) { return String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" }); });
    sel.appendChild(h("option", { value: "", text: items.length ? "Pick a stock item" : "No stock items yet" }));
    items.forEach(function (i) { sel.appendChild(h("option", { value: i.id, text: optName(i.name) + (i.total_qty != null ? " (" + fmt(i.total_qty) + ")" : "") })); });
    if (withCreate) sel.appendChild(h("option", { value: "__new", text: "+ Create stock item..." }));
  }
  function linkControls(u) {
    var sel = h("select", { cls: "sel ls-isel", "aria-label": "Stock item for " + u.label }); itemOptions(sel, true);
    var per = h("input", { type: "number", min: "0.01", step: "0.01", value: "1", cls: "ls-per", "aria-label": "How many per object", inputmode: "decimal" });
    var mode = h("select", { cls: "sel", "aria-label": "Count per object or per seat" }, [h("option", { value: "objects", text: "per object" }), h("option", { value: "seats", text: "per seat" })]);
    if (n(u.seats) > 0 && /chair|seat/i.test(String(u.label || "") + " " + String(u.layout_type || ""))) mode.value = "seats";
    var go = h("button", { type: "button", cls: "btn sm primary", text: "Link" });
    go.addEventListener("click", function () {
      if (go.disabled) return;
      var p = Number(per.value);
      if (!(p > 0) || p > 10000 || Math.round(p * 100) / 100 !== p) { toast("How many per object: a number above 0 with at most 2 decimals.", "err"); per.focus(); return; }
      if (sel.value === "__new") { createFlow(u, p, mode.value); return; }
      if (!sel.value) { toast("Pick the stock item first.", "info"); sel.focus(); return; }
      go.disabled = true;
      root.BPStore.inventory.layout.setLink(u.layout_type, sel.value, p, mode.value)
        .then(function () { toast("Linked " + u.label + ".", "ok"); return refresh(); })
        .catch(function (e) { toast(friendly(e, "link the product"), "err"); })
        .then(function () { go.disabled = false; });
    });
    return h("div", { cls: "ls-ctl" }, [sel, h("span", { cls: "ls-x", text: "x" }), per, mode, go]);
  }
  function renderLinks() {
    var host = $("lsLinkBody"); if (!host) return;
    clear(host);
    var un = unlinkedAll(S.overview, S.hidden), nHidden = Object.keys(S.hidden).length;
    if (!un.length) host.appendChild(h("p", { cls: "ls-empty", text: "Every product in the upcoming floor plans is linked to stock." }));
    un.forEach(function (u) {
      var bits = fmt(u.objects) + " in " + u.events + " event" + (u.events === 1 ? "" : "s") + (u.seats ? " · " + fmt(u.seats) + " seats" : "");
      var row = h("div", { cls: "ls-lrow" }, [h("div", { cls: "ls-lname" }, [h("b", { text: u.label }), h("span", { cls: "ls-sub", text: catName(u.category) + " · " + bits })])]);
      if (S.canEdit) {
        row.appendChild(linkControls(u));
        var hide = h("button", { type: "button", cls: "ls-linkbtn", text: "Not stock", title: "Hide this product here (for example a zone like Exit or Parking). Only on this browser." });
        hide.addEventListener("click", function () { S.hidden[u.layout_type] = 1; writeHidden(S.hidden); renderTab(); });
        row.appendChild(hide);
      }
      host.appendChild(row);
    });
    if (nHidden) {
      var show = h("button", { type: "button", cls: "ls-linkbtn", text: "Show " + nHidden + " hidden (not stock)" });
      show.addEventListener("click", function () { S.hidden = {}; writeHidden(S.hidden); renderTab(); });
      host.appendChild(h("p", { cls: "ls-sub" }, [show]));
    }
    // the links already made, per layout product
    var lk = $("lsLinked"); if (!lk) return;
    clear(lk);
    var byType = {};
    (S.links || []).forEach(function (l) { (byType[l.layout_type] = byType[l.layout_type] || []).push(l); });
    var labels = {}; ((S.overview && S.overview.events) || []).forEach(function (e) { (e.types || []).forEach(function (t) { labels[t.layout_type] = typeLabel(t.layout_type, t.label); }); });
    var types = Object.keys(byType).sort(function (a, b) { return (labels[a] || a).localeCompare(labels[b] || b); });
    if (!types.length) { lk.appendChild(h("p", { cls: "ls-empty", text: "No links yet." })); return; }
    types.forEach(function (t) {
      var lab = labels[t] || typeLabel(t);
      var ul = h("ul", { cls: "ls-llist" });
      byType[t].forEach(function (l) {
        var li = h("li", {}, [h("span", { text: optName(l.item_name) + " x " + String(Number(l.per_object) || 1) + (l.count_mode === "seats" ? " per seat" : " per object") + (l.item_active === false ? " (item switched off)" : "") })]);
        if (S.canEdit) {
          var rm = h("button", { type: "button", cls: "rm", text: "Remove", "aria-label": "Remove link " + lab + " to " + (l.item_name || "item") });
          rm.addEventListener("click", function () {
            Promise.resolve(root.BPUI && root.BPUI.confirm ? root.BPUI.confirm("Stop counting " + (l.item_name || "this item") + " for " + lab + "? Reservations already made stay as they are.", { title: "Remove link?", okLabel: "Remove" }) : true)
              .then(function (ok) { if (!ok) return; return root.BPStore.inventory.layout.removeLink(l.link_id).then(function () { toast("Link removed.", "ok"); return refresh(); }); })
              .catch(function (e) { toast(friendly(e, "remove the link"), "err"); });
          });
          li.appendChild(rm);
        }
        ul.appendChild(li);
      });
      var grp = h("div", { cls: "ls-lgrp" }, [h("b", { text: lab }), ul]);
      if (S.canEdit) {
        var more = h("button", { type: "button", cls: "ls-linkbtn", text: "+ Add another stock item" });
        more.addEventListener("click", function () { more.replaceWith(linkControls({ layout_type: t, label: lab, seats: 1 })); });
        grp.appendChild(more);
      }
      lk.appendChild(grp);
    });
  }

  /* ---- dialogs ---- */
  function modal(title, body, okText, onOk) {
    var prev = doc.activeElement;
    var err = h("div", { cls: "err", role: "alert", hidden: true });
    var ok = h("button", { type: "button", cls: "btn primary", text: okText });
    var cancel = h("button", { type: "button", cls: "btn", text: "Cancel" });
    var x = h("button", { type: "button", cls: "close", "aria-label": "Close", "data-close": true, text: "x" });
    var tid = "lsdlg" + Math.random().toString(36).slice(2, 8);
    var wrap = h("div", { cls: "lmodal", role: "dialog", "aria-modal": "true", "aria-labelledby": tid }, [
      h("div", { cls: "sheet ls-sheet" }, [h("h3", {}, [h("span", { id: tid, text: title }), x]), body, err,
        h("div", { cls: "foot" }, [h("span", { cls: "spacer" }), cancel, ok])])]);
    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); if (prev && prev.focus) { try { prev.focus(); } catch (e) {} } }
    x.addEventListener("click", close); cancel.addEventListener("click", close);
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
    ok.addEventListener("click", function () {
      if (ok.disabled) return; ok.disabled = true; err.hidden = true;
      Promise.resolve().then(onOk).then(function (r) { if (r !== false) close(); })
        .catch(function (e) { err.textContent = (e && e.userText) || friendly(e, "save"); err.hidden = false; })
        .then(function () { ok.disabled = false; });
    });
    doc.body.appendChild(wrap);
    setTimeout(function () { try { (wrap.querySelector("input,select") || ok).focus(); } catch (e) {} }, 30);
    return { close: close, err: err };
  }
  function userErr(msg) { var e = new Error(msg); e.userText = msg; return e; }

  function createFlow(u, per, mode) {
    var name = h("input", { id: "ls_cname", maxlength: "120", value: u.label });
    var cat = h("input", { id: "ls_ccat", maxlength: "60", value: catName(u.category) });
    var qty = h("input", { id: "ls_cqty", type: "number", min: "0", step: "1", inputmode: "numeric", value: "" });
    var unit = h("input", { id: "ls_cunit", maxlength: "20", value: "pcs" });
    var body = h("div", {}, [
      h("p", { cls: "sub", text: "A new stock item, linked to " + u.label + " (" + String(per) + (mode === "seats" ? " per seat" : " per object") + "). Nothing is reserved yet." }),
      h("div", { cls: "fgrid" }, [
        h("div", { cls: "fld" }, [h("label", { "for": "ls_cname", text: "Name *" }), name]),
        h("div", { cls: "fld" }, [h("label", { "for": "ls_ccat", text: "Category" }), cat]),
        h("div", { cls: "fld" }, [h("label", { "for": "ls_cqty", text: "How many you own *" }), qty]),
        h("div", { cls: "fld" }, [h("label", { "for": "ls_cunit", text: "Unit" }), unit])])]);
    modal("Create stock item", body, "Create and link", function () {
      var nm = String(name.value || "").trim();
      if (!nm) throw userErr("Give the item a name.");
      var q = qty.value === "" ? NaN : Number(qty.value);
      if (!(q >= 0) || q !== Math.trunc(q) || q > 100000000) throw userErr("How many you own: a whole number, 0 or more.");
      return root.BPStore.inventory.addItem({ name: nm.slice(0, 120), category: String(cat.value || "").trim() || null, total_qty: q, unit: String(unit.value || "").trim() || null })
        .then(function (row) {
          if (!row || !row.id) throw userErr("The item was not saved.");
          return root.BPStore.inventory.layout.setLink(u.layout_type, row.id, per, mode);
        })
        .then(function () { toast("Created " + nm + " and linked it to " + u.label + ".", "ok"); return Promise.resolve(S.o && S.o.reload && S.o.reload()).then(refresh); });
    });
  }

  function reserveFlow(block, btn) {
    var plan = reservePlan(block);
    if (!plan.lines.length) { toast("Everything in the floor plan is already reserved.", "info"); return; }
    var ul = h("ul", { cls: "ls-plan" });
    plan.lines.forEach(function (l) {
      ul.appendChild(h("li", {}, [h("b", { text: optName(l.name) }), ": reserve " + fmt(l.qty) + (l.unit ? " " + l.unit : "") + " - "
        + (l.short ? fmt(l.fromStock) + " from stock, " + fmt(l.short) + " short" : "all from stock")]));
    });
    var kids = [h("p", { cls: "sub", text: (block.title || "This event") + " · " + dateText(block) }), ul];
    var src = null, vend = null, note = null;
    if (plan.short > 0) {
      src = h("select", { id: "ls_src", cls: "sel" }, [h("option", { value: "none", text: "Leave unsourced (decide later)" }),
        h("option", { value: "buy", text: "Buy / outsource" }), h("option", { value: "vendor", text: "Rent from a vendor" })]);
      vend = h("select", { id: "ls_vend", cls: "sel", hidden: true }, [h("option", { value: "", text: "Loading vendors..." })]);
      note = h("input", { id: "ls_snote", maxlength: "200", placeholder: "Optional note" });
      src.addEventListener("change", function () { vend.hidden = src.value !== "vendor"; });
      var S2 = root.BPStore;
      (S2.vendors && S2.vendors.listAll ? S2.vendors.listAll(false) : Promise.resolve([])).catch(function () { return []; }).then(function (list) {
        clear(vend); vend.appendChild(h("option", { value: "", text: (list || []).length ? "Pick a vendor" : "No vendors yet - add one under Partners" }));
        (list || []).forEach(function (v) { vend.appendChild(h("option", { value: v.id, text: optName(v.name) + (v.category ? " · " + v.category : "") })); });
      });
      kids.push(h("p", { cls: "ls-warn", text: fmt(plan.short) + " are not free on these days. They are recorded as a shortfall on the event:" }),
        h("div", { cls: "ls-src" }, [h("label", { "for": "ls_src", cls: "sr-only", text: "Source for the shortfall" }), src,
          h("label", { "for": "ls_vend", cls: "sr-only", text: "Vendor" }), vend, h("label", { "for": "ls_snote", cls: "sr-only", text: "Note" }), note]));
    }
    kids.push(h("p", { cls: "ls-sub", text: "Reservations already made stay as they are. Nothing is taken out of the store yet." }));
    modal("Reserve from layout", h("div", {}, kids), "Reserve " + fmt(plan.fromStock) + (plan.short ? " + record " + fmt(plan.short) + " short" : ""), function () {
      var source = src ? src.value : "none", vendorId = vend && source === "vendor" ? vend.value : null;
      if (source === "vendor" && !vendorId) throw userErr("Pick the vendor to rent from.");
      var vendorName = vend && vendorId ? (vend.options[vend.selectedIndex] || {}).text : null;
      var done = { reserved: 0, short: 0, failed: [] };
      return plan.lines.reduce(function (p, l) {
        return p.then(function () {
          return root.BPStore.inventory.reserveWithSourcing(l.item_id, block.quote_id, l.qty, "From the floor plan",
            { source: source, vendorId: vendorId, vendorName: vendorName, sourceNote: note && note.value ? note.value.trim() : null })
            .then(function (r) { done.reserved += n(r && r.reserved); done.short += n(r && r.short); })
            .catch(function (e) { done.failed.push(optName(l.name) + ": " + friendly(e, "reserve")); });
        });
      }, Promise.resolve()).then(function () {
        var msg = "Reserved " + fmt(done.reserved) + (done.short ? ", " + fmt(done.short) + " short recorded" : "") + ".";
        if (done.failed.length) { toast(msg + " Not done: " + done.failed.join("; "), "err"); } else toast(msg, "ok");
        return Promise.resolve(S.o && S.o.reload && S.o.reload()).then(refresh);
      });
    });
  }

  /* ---- the per-event panel (?quote=) ---- */
  function renderPanel(block) {
    var host = $("layoutNeeds"); if (!host) return;
    clear(host);
    if (!block) { host.hidden = true; return; }
    host.hidden = false;
    host.appendChild(h("h3", { cls: "ls-h", text: "From the floor plan" }));
    host.appendChild(h("p", { cls: "sub", text: block.version_no ? "What the latest 2D / 3D floor plan needs, against what is free on this event's stock days." : "No floor plan saved for this event yet." }));
    if (block.version_no) blockBody(block, true).forEach(function (k) { host.appendChild(k); });
  }

  /* ---- the top strip ---- */
  function renderStrip() {
    var host = $("invSummary"); if (!host || S.quoteId) { if (host) host.hidden = true; return; }
    var set = function (id, v) { var el = $(id); if (el) el.textContent = v == null ? "-" : fmt(v); };
    // the stock numbers only once the stock list is in (until then the skeleton stays - no 0 flashing)
    if (!S.o.ready || S.o.ready()) {
      var s = strip(S.o.items ? S.o.items() : [], S.o.checkouts ? S.o.checkouts() : [], S.overview);
      if (S.o.outNow) s.outNow = S.o.outNow();
      set("isItems", s.items); set("isUnits", s.units); set("isOut", s.outNow);
    }
    // events short: once the floor-plan read answered ("-" on a database without 0430; the tile keeps its place)
    if (S.available !== null) {
      var ev = S.available ? (S.overview && S.overview.summary ? n(S.overview.summary.events_short) : null) : null;
      set("isShort", ev);
      var tile = $("isShortTile");
      if (tile) { tile.classList.toggle("is-short", n(ev) > 0); tile.disabled = !S.available; if (!S.available) tile.title = "Needs the latest database update"; }
    }
  }

  function refresh() {
    var L = root.BPStore && root.BPStore.inventory && root.BPStore.inventory.layout;
    if (!L) { S.available = false; hideFeature(); return Promise.resolve(); }
    var from = today(), to = addDays(from, S.days);
    var jobs = [L.overview(from, to), L.links()];
    if (S.quoteId) jobs.push(L.needs(S.quoteId));
    return Promise.all(jobs.map(function (p) { return Promise.resolve(p).catch(function (e) { return { __err: e }; }); })).then(function (r) {
      var ov = r[0], lk = r[1], nd = r[2];
      if (ov === null) { S.available = false; hideFeature(); renderStrip(); return; }   // local mode / database without 0430
      S.available = true; showFeature();
      if (ov && ov.__err) { S.overview = { events: [], summary: { events: 0, events_short: 0 } }; var hst = $("lsEvents"); if (hst) { clear(hst); hst.appendChild(h("p", { cls: "err", text: friendly(ov.__err, "load the floor-plan products") })); } }
      else S.overview = ov;
      S.links = Array.isArray(lk) ? lk : [];
      if (!(ov && ov.__err)) renderTab();
      if (S.quoteId) renderPanel(nd && !nd.__err ? nd : null);
      renderStrip();
    });
  }
  function hideFeature() { ["tabLayout", "layoutNeeds"].forEach(function (id) { var el = $(id); if (el) el.hidden = true; }); }
  function showFeature() { var t = $("tabLayout"); if (t) t.hidden = false; }

  function mount(o) {
    S.o = o || {}; S.quoteId = S.o.quoteId || null; S.canEdit = !!S.o.canEdit;
    var rs = $("lsRange");
    if (rs && !rs.dataset.bound) {
      rs.dataset.bound = "1";
      RANGES.forEach(function (d) { rs.appendChild(h("option", { value: String(d), text: "Next " + d + " days" })); });
      rs.value = String(S.days);
      rs.addEventListener("change", function () { S.days = Number(rs.value) || 30; refresh(); });
      var so = $("lsShortOnly"); if (so) so.addEventListener("change", function () { S.shortOnly = !!so.checked; renderTab(); });
      var ev = $("lsEvents");
      if (ev) ev.addEventListener("click", function (e) { var t = e.target && e.target.closest && e.target.closest("[data-ls-goto]"); if (t) { var l = $("lsLinks"); if (l && l.scrollIntoView) l.scrollIntoView({ behavior: "smooth", block: "start" }); } });
      var st = $("isShortTile");
      if (st) st.addEventListener("click", function () { if (S.o.openTab) S.o.openTab("layout"); });
    }
    return refresh();
  }
  // the page reloaded its stock (items / check-outs): only the strip changes
  function stockChanged() { if (S.o) renderStrip(); }

  api.mount = mount; api.refresh = refresh; api.stockChanged = stockChanged;
  root.HelmLayoutStock = api;
})(typeof window !== "undefined" ? window : this);
