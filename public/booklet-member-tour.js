/* booklet-member-tour.js - R224: the in-app "? Tour" (page-tours.js + tour.js) on the booklet is for a signed-in studio
   member previewing it only (page-tours.js: booklet entry signedIn:true). A client opening the booklet link never
   downloads it. booklet.html carries the two scripts as inert <script type="text/plain" data-member-tour> tags; when
   client-api.js runs in full mode (this browser holds a Helm sign-in, or the free-trial preview) they become real
   scripts, in order. Loaded right after client-api.js, before the tags. */
(function () {
  try {
    if (window.__HELM_CLIENT_FULL__ !== true) return;
    var add = function () {
      var tags = document.querySelectorAll('script[type="text/plain"][data-member-tour]');
      for (var i = 0; i < tags.length; i++) {
        var t = tags[i], s = document.createElement("script");
        s.async = false; s.src = t.getAttribute("src");
        t.parentNode.insertBefore(s, t.nextSibling);
      }
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
  } catch (e) {}
})();
