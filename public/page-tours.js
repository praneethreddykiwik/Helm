/* =========================================================================
   HELM — page tours: the ONE place every "Tour this page" lives.
   -------------------------------------------------------------------------
   >>> When you add or change a feature, update its tour here. <<<
   test/page-tours-coverage.test.mjs fails the build when an app page (one
   that gets the shared header from shell-proto.js) has no entry here, or
   when a step's selector no longer exists in that page's HTML / JS.

   The engine is tour.js (spotlight, next / back / skip, Esc, focus, mobile,
   reduced motion). This file is data only. Each step is:
     { sel, title, desc }        sel = CSS selector, or a list of fallbacks
                                 (the first one VISIBLE on screen wins)
     need: "area" | "edit:area" | "create" | [..]   skip unless this role
                                 has that access (same BPStore.auth checks
                                 the page uses: canView / canEditArea / can)
     uses + alt(can)             role-specific wording (see tour.js wording())
     trial: false                never shown to a free-trial studio
     side: "right" | ...         preferred side for the card
   A step whose target is missing, hidden for this role / plan, or not on
   screen right now is SKIPPED, never fatal. Keep each tour 4-8 short steps
   in on-screen reading order (top to bottom, left to right).

   An entry is one of:
     [steps]                                  the page's tour
     { sections: { key: [steps] }, section() , fallback }
                                              one tour per section (Control
                                              Center); section() reads the
                                              section on screen right now
     { own: "#helpBtn" }                      the page runs its own tour
                                              (the dashboard first-run tour
                                              in dashboard.html)
   Seen-state is remembered per page (and per section) by tour.js under
   localStorage "helm_tour_seen_<page>[_<section>]"; a tour can always be
   replayed from the "?" menu or the sidebar's "Tour this page".
   ========================================================================= */
(function (root) {
  "use strict";
  // R164: the builder on a phone (builder-immersive.js) - its floating controls describe themselves differently
  function phoneView() { try { return !!(window.__helmImmersive && window.__helmImmersive.isPhone()); } catch (_) { return false; } }
  function inTrial() { try { return document.documentElement.classList.contains("helm-trial"); } catch (_) { return false; } }

  const TOURS = {
    /* ---------------- the floor builder (own header, no app shell) ---------------- */
    // Steps follow the on-screen reading order: the top bar left to right, then the
    // panels below it (the old order jumped between the bar and the toolbox).
    "builder.html": [
      // r20: the header is the one-row header again (left to right: logo, start a floor, units / grid / view /
      // measure, undo / redo / clear, this layout, capacity, hide amounts), then the toolbox, the view dock and the
      // price panel. Controls that are hidden here (outside a quote, in a free trial, for this role or screen) are skipped.
      // R164: on a phone the top bar is folded away and the controls float over the floor (builder-immersive.js); the
      // floating steps below exist only there, and the top-bar steps are skipped there (hidden) - and the other way round
      { sel: ["header .brand", "#bimBack"], title: "Back home", desc: "The Helm logo (on a phone: the ← button) takes you back to your events. Tip: press H (when you are not typing) to jump home to the dashboard from any screen." },
      { sel: "#bimMore", side: "left", title: "More", desc: "On a phone the top bar is folded away: More opens it (template, Create layout, units, grid, Render, Measure, undo, name, Open, capacity). Tap outside it or Close to fold it." },
      { sel: "#bimNav", side: "left", title: "App bar", desc: "The app's bottom bar (Home, Search, +, Alerts, Profile) is folded away in the builder. This handle brings it up or down." },
      { sel: "#preset", title: "Start from a template", desc: "Want a head start? Pick a ready-made layout (wedding, conference, concert...) or one of your own templates, then tweak it." },
      { sel: "#refField", title: "Reuse a past event", desc: "Copies the floor of one of your earlier events onto this canvas, at today's prices." },
      { sel: "#customBtn", title: "...or create your own floor", desc: "Type your hall length x breadth and guest count; Helm sizes the canvas to your hall and arranges the seating." },
      { sel: "#unitSel", title: "Units", desc: "Work in feet or metres." },
      { sel: [".seg:has(#snapBtn)", "#snapBtn"], title: "Snap and Grid", desc: "Snap makes objects jump to the grid lines when you move them; Grid shows or hides the lines." },
      { sel: ["#viewSeg", "#bimRail"], title: "2D, 3D and Render", get desc() { return inTrial()
        ? "Edit in the 2D plan, walk around it in 3D, or press Render for a realistic 3D look of the same floor. AI photos of the plan come with a paid plan."
        : "Edit in the 2D plan, walk around it in 3D, or press Render to make a photo-like picture of the plan. All three show the same floor."; } },
      { sel: [".wt-field", "#wtStart"], title: "Explore in 3D", desc: "Quick 3D views of the venue: Overview, Floor plan and Evening lighting, plus the guided Walkthrough." },
      { sel: ["#wtStart", ".wt-fab"], title: "3D walkaround", desc: "Walkthrough (in Explore) flies through your venue one area at a time: entrance, stage, seating, lounges, bar, food, photo spots. Aisles and ramps show with their area. Drag to look around (pauses). Esc exits." },
      { sel: "#measureBtn", title: "Measure", desc: "Turn on Measure, then select an object to see its distance from all four walls and its nearest neighbour on every side." },
      { sel: ".hg-edit", title: "Undo, Redo, Clear", desc: "Step back or forward through your changes (⌘Z / ⌘⇧Z). Clear removes every object - you can still Undo it." },
      { sel: "#projName", title: "Name this layout", desc: "The event or quote name. Saved with every version of the floor." },
      { sel: "#verSel", title: "Versions", desc: "Every Save keeps a numbered version. Pick an older one to look at it; saved versions are never changed." },
      { sel: "#designChip", title: "Design stage", desc: "Opens the Design Studio for this event." },
      { sel: "#backToFlowBtn", title: "Save & back to the quote", desc: "Saves this floor as a new version and takes you back to the quotation. If the quote was already sent to the client, you are asked first before its price changes (Update quote / Keep quote)." },
      { sel: ["#saveBtn", "#bimSave"], title: "Save", desc: "Saves a new version of this floor (⌘S / Ctrl+S). The chair count flows straight into the price breakdown on the right." },
      { sel: "#loadBtn", title: "Open", desc: "Open another saved layout." },
      { sel: "#clientImgBtn", trial: false, title: "Client images", desc: "Captures a clean 2D plan and 3D view of this floor for the client booklet." },
      { sel: "#moreMenu", title: "More", desc: "Download the floor as a PNG picture or a JSON file, or import a JSON layout." },
      { sel: ".hg-cap", title: "Capacity & seats", desc: "Type the venue's capacity; the chip shows the seats placed against it and warns when a block is packed too tight to walk through." },
      { sel: [".bp-priv-slot .hbp-btn", ".bp-priv-slot"], title: "Hide amounts", desc: "The eye hides every price on the screen - handy when a client is looking over your shoulder. Showing them again asks for your PIN." },
      // R154i: on a phone (upright or sideways) the toolbox and the price / inspector panel are drawers that are off screen until
      // opened, so these two steps fall back to their Tools / Inspector buttons there
      { sel: ["#toolbox", "#toolsToggle", "#bimTools"], side: "right", title: "Drag any asset", desc: "Drag stages, chairs, tables, bars, exits - anything - onto the floor. Every object can be moved, resized and rotated. On a phone, tap Tools to slide the toolbox in." },
      { sel: "#fabStack", title: "Zoom & move around", get desc() { return phoneView()
        ? "Zoom in (+), zoom out (−) and FIT the whole floor, full screen (⛶) and this tour. One finger moves the floor, two fingers zoom it. In full screen everything keeps working; ✕ Exit (top left) leaves it."
        : "Zoom out / in, FIT the whole floor, the arrows to pan and fullscreen. These sit under the floor so they never cover it. To hide them, press the down arrow (⌄); the small “⊕ View” button brings them back."; } },
      { sel: ["#rightPanel", "#inspToggle", "#bimInsp"], side: "left", title: "Price & inspector", desc: "The menu package, guests and live price for this floor. Select an object to edit its size, position, rotation and colour here. On a phone, tap Inspector to open it." },
      // R135 + R137: the stage screen (layout, theme, colour, logo, words) + stairs, shown once a stage or a screen is selected
      { sel: ["#inspector .isec.screen", "#rightPanel"], side: "left", title: "Stage screen, steps & stairs", desc: "Select the stage or a screen: layout, theme or colour, logo and words - OR Upload a picture (Helm shows its real size and the pixels to make, e.g. 1920 x 1080). Toolbox: 3 screens (centre + 2 sides) and Welcome Board." },
    ],
    "quotes.html": [
      { sel: "#tabs", title: "Find confirmed fast", desc: "Active · Quotes · Confirmed · Archive · Deleted. Confirmed events rise to the top and are highlighted so you never scroll to find them." },
      { sel: "#tab_inprogress", title: "In progress", desc: "Every quote that is not confirmed yet - still being prepared, or shared and waiting for the client - with the step it reached and who worked on it last. Continue picks it up right there." },
      { sel: "#search", title: "Search", desc: "Jump to any quote by client name or quote code." },
      { sel: "#typeFilter", title: "Filter", desc: "Show only one event type, or quotes from a date range." },
      { sel: "#newBtn", need: ["create", "edit:quotes"], title: "Start a new quote", desc: "Price a fresh event here. It becomes the event everything else hangs off." },
      { sel: "#rows", uses: "edit:quotes", alt: (can) => can("edit:quotes") ? null : { desc: "Click a row to open the event and see its details." },
        title: "Your quotes", desc: "Click a row to open it, confirm it, re-price it, or take client approval by OTP / consent / payment link. A quote that is not confirmed yet has a Continue button that takes you back to the step you left." },
    ],
    "flow.html": [
      { sel: "#code", title: "The event workspace", desc: "Every stage of this one event lives here, top to bottom — fill it in order and nothing gets missed. Opened on another step? A Continue where you left off note takes you to the step that is next." },
      { sel: "#sec-client", title: "1 · Client", desc: "Who the event is for. Saved here, reused everywhere." },
      { sel: "#sec-discovery", title: "2 · Discovery", desc: "Capture requirements and the budget range before you price." },
      { sel: "#sec-proposal", title: "3 · Proposal", desc: "Your pitch to the client — it sits above the floor layout so you sell first, then plan." },
      { sel: "#sec-layout", title: "4 · Floor layout", desc: "Open the builder. The chairs you place here feed straight back into the quotation." },
      { sel: "#sec-quote", title: "5 · Quote", desc: "Final pricing and confirmation. Confirming sets the event live." },
      { sel: "#sec-approve", title: "Share & approval", desc: "Send the client one private link to approve. Change the \"Valid until\" date (dd/mm/yyyy); Undo fixes a mis-click. Client 2D / 3D images need a paid plan. Trial: (Preview) buttons show it all, no link is made." },
      { sel: "#sec-pay", need: "finance", title: "6 · Payment", desc: "Record the advance (amount, method, receipt no.) to confirm the booking, and pick a payment schedule - you see the split (e.g. 30% / 50% / 20%) before you add it." },
    ],
    "logistics.html": [
      { sel: "#tabs", title: "Event logistics", desc: "Everything that has to happen for this event, organised by section (stage, lighting, catering…)." },
      { sel: "#tplBar", trial: false, title: "Apply a template", desc: "Drop a saved checklist into this event in one click — no retyping the same tasks every time. (You build templates in Settings.)" },
      { sel: "#a_title", title: "Add a one-off task", desc: "Need something the template didn't cover? Add your own task right here." },
      { sel: "#pane", title: "Assign & track", desc: "Assign staff to each task and tick off progress as the event comes together." },
    ],
    "leads.html": [
      { sel: "#search", title: "Find anyone fast", desc: "Search by name, phone or event type across every column." },
      { sel: "#archBtn", title: "Archived leads", desc: "Leads you archived are kept here, never lost. Open one to bring it back." },
      { sel: "#enqBtn", title: "Your enquiry form", desc: "A public form for your website. Every enquiry it receives lands here as a New lead." },
      { sel: "#newBtn", need: "edit:leads", title: "Capture a lead", desc: "Every enquiry starts here. Click + New lead to open the form and record who got in touch." },
      { sel: "#board", uses: "edit:leads", alt: (can) => can("edit:leads") ? null : { desc: "Leads sit in columns by stage — New, Qualified, Discovery, Quoted, Won, Lost. Open a lead to see its details." },
        title: "The pipeline board", desc: "Leads sit in columns by stage — New, Qualified, Discovery, Quoted, Won, Lost. Drag a card between columns to move it along." },
    ],
    "staff.html": [
      { sel: "#search", title: "Find a person", desc: "Search by name or role to quickly pull someone up." },
      { sel: "#deptFilter", title: "Filter", desc: "Show one department or one skill, or include people who no longer work with you." },
      { sel: "#importBtn", trial: false, title: "Import", desc: "Bring your whole team in from an Excel or CSV file." },
      { sel: "#newBtn", title: "Add your team", desc: "Add an in-house team member with their name, phone and department (stage, lighting, catering…)." },
      { sel: "#cantwork-requests", title: "Day-off requests", desc: "Staff ask for days off from their link (at least 7 days ahead - closer days they call you). Approve or turn down with a note; they are told and tap OK, got it. Waiting and approved days warn you when you assign work." },
      { sel: "#grid", title: "Your people", desc: "Everyone on the team, by department. You assign them to event tasks from an event's Logistics page." },
      { sel: ".person .tag.login-none, .person .tag.login-invited", title: "Login status", desc: "No login = a record only: they get their work through their task link. Invited - not signed up = an invite link is waiting; Cancel invite stops it if they only need the task link. Linked account = they sign in to Helm." },
      { sel: '[data-act="tlink"]', title: "Permanent task link", desc: "Task link copies one link per person that always shows their current tasks on every event - it is also in every task e-mail. New task link stops the old one at once." },
    ],
    "inventory.html": [
      { sel: "#eventPanel", title: "Reserve for an event", desc: "Book items to a specific event — this is what the close-out later checks is returned." },
      { sel: "#stockDates", title: "Stock dates", desc: "A multi-day event or a set-up the day before: set the set-up and teardown days and the stock stays held for the whole range. Other events holding the same items on those days are listed." },
      { sel: "#search", title: "Find stock", desc: "Search items, or filter by category and value grade (A / B / C)." },
      { sel: "#seedBtn", title: "A quick start", desc: "Adds a ready-made list of common event items you can edit." },
      { sel: "#newBtn", title: "Add stock", desc: "Add equipment to your inventory, graded A / B / C by value so losses are easy to price." },
      { sel: ["#pane-loans", '[aria-controls="pane-loans"]'], title: "Check out & back in", desc: "Issue stock to a person and record how much comes back. Anything short is flagged with its rupee value." },
      { sel: "#lossRows", title: "Losses", desc: "Items lost or damaged. Follow-up on each line: Found (a late return goes back into stock), Send to repair, Add photo, and - with Finance access - who pays: the studio or the client." },
      { sel: "#stockSettings", title: "Stock settings", desc: "Ask for a photo of damaged or missing items, show damage charges on the client portal, let stock staff see costs, and add buffer days for cleaning." },
    ],
    "vendors.html": [
      { sel: "#viewTabs", title: "Partners and requests", desc: "Your vendor list, or the requests and invoices you sent them." },
      { sel: "#kindTabs", title: "Vendor categories", desc: "Outside partners grouped by what they provide — catering, sound, décor, transport and more." },
      { sel: "#search", title: "Search", desc: "Find a vendor by name or what they provide." },
      { sel: "#newBtn", title: "Add a vendor", desc: "Record a partner once (contact + rates) and reuse them across events." },
      { sel: "#grid", title: "Your partner list", desc: "Everyone you work with. Book them for the gaps your in-house team can't cover." },
    ],
    "calendar.html": [
      { sel: "#cvBar", title: "Events, team or live", desc: "Events = which event is on when. Team = who works when (days someone marked they can't work show in red). Live today = the progress of today's events right now." },
      { sel: ["#evcal", "#schedule", "#liveToday"], title: "The month at a glance", desc: "Every dated event in one view. Click an event to open it. On Live today, each event shows how many tasks are done, started, accepted, waiting and late." },
      { sel: "#conflicts", title: "Clash detection", desc: "Helm flags staff or stock booked on two events at once, and anyone given work on a day they marked they can't work — before it becomes a problem on the day." },
      { sel: "#agenda", title: "Every event, dated", desc: "A running schedule of all your events so nothing collides." },
      { sel: "#nodateWrap", title: "No date yet", desc: "Quotes without an event date wait here. Give them a date to put them on the calendar." },
    ],
    "control.html": {
      // One tour per Settings section (control-split.js). The section on screen is the
      // .cs-main[data-cs-cur] attribute; before the split loads, the URL #hash; else Pricing.
      section: function () {
        try {
          const m = document.querySelector(".cs-main[data-cs-cur]");
          if (m) return m.getAttribute("data-cs-cur");
        } catch (_) {}
        return HASH[String((root.location && root.location.hash) || "").toLowerCase()] || null;
      },
      fallback: "pricing",
      sections: {
        general: [
          { sel: "#o_name", title: "Your studio", desc: "Studio name, contact details and logo. They appear on quotes, booklets and every e-mail to clients." },
          { sel: "#o_country", title: "Country, tax and currency", desc: "Sets the tax rules, currency and phone format Helm uses everywhere for your studio." },
          { sel: "#o_line1", title: "Billing address", desc: "The address printed on your quotes and invoices." },
          { sel: "#slugBox", title: "Your client link name", desc: "The short name in every link you send clients (helm.events/your-studio)." },
          { sel: "#o_save", title: "Save", desc: "Nothing changes until you press Save studio settings." },
        ],
        billing: [
          { sel: "#subCard", title: "Your Helm plan", desc: "Which plan you are on, when it renews and how many seats it includes." },
          { sel: "#subBody", title: "Invoices and upgrades", desc: "Download Helm invoices, or ask to change your plan. Only an admin sees billing." },
          { sel: "#tdControl", title: "Sample data", desc: "In a free trial, the sample events and clients you can clear or bring back." },
        ],
        privacy: [
          { sel: "#privPinCard", title: "Hide amounts", desc: "The eye in the top bar hides every price on screen. This 4-digit PIN shows them again." },
          { sel: "#pp_state", title: "Is a PIN set?", desc: "Shows whether your studio has its own PIN or still uses the starting one (0000)." },
          { sel: "#pp_new", title: "Change the PIN", desc: "Type the current PIN, then the new one twice. One PIN for the whole studio." },
          { sel: "#pp_reset", title: "Forgot it?", desc: "An admin can reset the PIN back to 0000, then set a new one." },
        ],
        links: [
          { sel: "#lxCard", title: "Client links expire", desc: "Choose how many days a client link stays open after you send it." },
          { sel: "#qvCard", title: "Quote validity", desc: "Give every new quote a valid-until date, with a reminder before it runs out." },
          { sel: "#pkgFlowCard", title: "Package choice", desc: "How clients pick a menu package from the booklet you send them." },
        ],
        pricing: [
          { sel: "#pricingCard", title: "Default pricing", desc: "Price per chair and per plate, tax and service charge. Every new quote starts from these." },
          { sel: "#p_svc", title: "Service charge and fees", desc: "Service charge, layout and setup fee, and the extra buffer added to every quote." },
          { sel: "#savePricing", title: "Save pricing", desc: "Only new quotes use new prices. Quotes you already sent keep theirs." },
          { sel: "#tmCard", title: "Target margin", desc: "The profit you aim for. Insights compares every event against it." },
          { sel: "#mlkCard", title: "Money rules", desc: "How wages (half days, overtime, allowance), client TDS, big cost gaps, cancelled events and closed events count in the margin. The defaults keep your numbers as they were." },
          { sel: "#itemPricingCard", title: "Rate cards", desc: "Prices for each object in the floor builder, and the most the builder lets you place." },
          { sel: "#co_code", title: "Coupons", desc: "Make a discount code (a fixed amount or a %) your team can apply to a quote." },
        ],
        payments: [
          { sel: "#pstCard", title: "Payment schedules", desc: "The payment plan added when a client approves: 30 / 50 / 20, 50 / 50, 100% upfront, or your own." },
          { sel: "#pst_default", title: "The default plan", desc: "Which plan new events get. You can still change it on any event." },
          { sel: "#pst_upi", title: "How clients pay", desc: "Your UPI ID and a payment note, shown to clients next to every amount due." },
          { sel: "#pst_new", title: "Your own schedule", desc: "Make a plan with your own milestones and due dates." },
          { sel: "#pst_save", title: "Save", desc: "Saves the plans and payment details." },
        ],
        catalog: [
          { sel: "#ch_name", title: "Chair types", desc: "The chairs you rent out and their prices. They show up in quotes and the builder." },
          { sel: "#pl_name", title: "Plate types", desc: "Catering plates and their per-plate prices." },
          { sel: "#dishFilter", title: "Dishes catalog", desc: "Every dish you serve. Search it, or add a new dish with its category." },
          { sel: "#menuCard", title: "Menu packages", desc: "Standard, Gold, Premium or your own: the packages clients pick from in their booklet." },
        ],
        rules: [
          { sel: "#layoutRuleList .lrx-list", title: "Event types", desc: "Pick an event type to edit its layout rule. A dot means it has unsaved changes. Add your own event type at the bottom." },
          { sel: "#layoutRuleList .lrx-ed", title: "One rule, in plain words", desc: "Seats for each guest, guests per round table, aisle width, when to add a buffet line, bars, exits and what goes on the floor. Use - and + or type a number." },
          { sel: "#layoutRuleList .lrx-pv", title: "Live preview", desc: "Type a guest count to see what the layout generator will start from for this event type." },
          { sel: "#layoutRuleList .lrx-acts", title: "Copy or reset", desc: "Copy the settings of another event type, or go back to Helm's defaults for this one." },
          { sel: "#layoutRuleList .lrx-bar", title: "One Save for everything", desc: "Changes to any event type wait here until you press Save changes. New layouts use them; floors you already made are not changed." },
        ],
        data: [
          { sel: "#imp_staff", title: "Import from Excel", desc: "Bring in staff, dishes, inventory and vendors from an Excel or CSV file." },
          { sel: "#cfCard", title: "Custom fields", desc: "Add your own fields (for example 'Shirt size') to staff, inventory and other records." },
          { sel: "#cf_add", title: "Add a field", desc: "Pick where it goes, name it, choose its type, then Add field." },
        ],
        users: [
          // R228: the page header button, the folding invite panel, filter tabs, one status per person, View / Edit / "..." menu (R229: Danger zone / Transfer ownership off)
          { sel: ["#inv_email", "#um_invite_btn"], title: "Invite people", desc: "The main way to add a teammate: Invite people, type their e-mail, pick a role, Send invite. They get a join link (7 days), choose their own password and join. A deactivated teammate's e-mail offers Reactivate instead." },
          { sel: ["#um_which", "#um_more"], title: "Which should I use?", desc: "Invite by email link (recommended): they choose their own password. Add user under More options (admins only): the login exists now and a temporary password is shown to you once. Learn more compares them with the Staff page options." },
          { sel: "#uc_tools", title: "Find a teammate", desc: "Search the team, or use the tabs to show only Active people, people Invited but not signed up, people who never signed in, incomplete profiles or Deactivated people. Each tab shows how many." },
          { sel: "#um_rows", title: "Team members", desc: "Everyone with a login, plus people invited but not signed up yet. Status shows the real state: Last signed in, Invited (and when the link expires), Never signed in, or Deactivated. Admins also show whether two-step is on." },
          { sel: "#um_rows .btn.primary", title: "One main button per person", desc: "Anyone not in yet has one clear next step under their status: Resend invite (an expired link gets a new 7-day one), Send sign-in link (never signed in), or Reactivate. Signed-in people have none." },
          { sel: "#um_rows .ucView", title: "View a person", desc: "View opens their details: the full e-mail (with Copy), phone, role, when they joined and last signed in, who invited them, and New temporary password for a never-used Add user login." },
          { sel: "#um_rows .ucMore", title: "More actions", desc: "The ⋯ button holds the rest: Deactivate (nothing is deleted), Remove access, Open work, Copy invite link or Cancel invite. Arrow keys move through it and Esc closes it." },
        ],
        access: [
          { sel: "#roleTabs", title: "Pick a role", desc: "Choose the role you want to set up: manager, planner, sales and so on. The box below says in plain words what that role can do, and Needs under a row lists what else must be on (Turn on fixes it)." },
          { sel: '#roleTabs .rtab[data-role="admin"]', title: "Admin always has full access", desc: "The admin role can always see and change everything. Nothing to switch here." },
          { sel: "#matrix .chip:not(.perm) .cview", title: "Can see", desc: "Switch on Can see to let this role see it. Green means the role can open that page." },
          { sel: "#matrix .chip:not(.perm) .pen", title: "Can change", desc: "Switch on Can change to also let the role change things there. It switches Can see on too." },
          { sel: "#mgrClose", title: "Managers can close events", desc: "On by default. Switch it off if only the admin should close events and settle accounts." },
          { sel: '#matrix .chip[data-area="discount_approve"]', title: "Finance: approve discounts", desc: "One switch. Lets this role approve a change that lowers the price. Nobody can approve their own discount." },
          { sel: '#matrix .chip[data-area="close_owed"]', title: "Finance: close with money owed", desc: "One switch. Lets this role close an event that still has a balance due. They must write a reason, and it is logged." },
          { sel: "#matrix", title: "Saved straight away", desc: "Each tap saves at once. People see the change the next time they open a page." },
        ],
        compliance: [
          { sel: "#btn-export-gdpr", title: "Download your data", desc: "Owner and admins only. Makes a file of your studio's data. It has personal details, so keep it private. Every download is logged." },
          { sel: "#exp_status", title: "Progress", desc: "Shows when the archive is ready to download." },
        ],
        notify: [
          { sel: "#nf_q", title: "Find a notification", desc: "Search the list or filter it by group." },
          { sel: "#nf_table", title: "Who hears about what", desc: "For each kind of alert, pick which roles get it in the bell and by text or e-mail." },
          { sel: "#nf_reset", title: "Back to defaults", desc: "Puts every notification back to how Helm set it up." },
          { sel: "#np_user", title: "Per-person overrides", desc: "Pick one person to mute or add alerts just for them." },
          { sel: "#trmCard", title: "Task reminders and escalation", desc: "Reminders for the person on each task. For special tasks not started, set when the coordinator, the manager and the admin / owner are told (0, 5 and 10 minutes after the start by default). It stops once the task is started." },
          { sel: "#sinCard", title: "Teammate sign-ins", desc: "When a teammate signs in, the owner and admins get a bell notice: name, role, time and browser. Choose Off, First sign-in each day (the default) or Every sign-in, and which roles count." },
        ],
        reminders: [
          { sel: "#evrCard", title: "Event reminders", desc: "Reminders to the team before each event." },
          { sel: "#cm_pay_before", title: "Payment reminders", desc: "When and how often clients are reminded about a payment that is due." },
          { sel: "#cm_fu_delay", title: "Client follow-ups", desc: "A friendly follow-up when a client has not replied to a quote." },
          { sel: "#cm_wa_num", title: "WhatsApp", desc: "The number client replies are forwarded to." },
          { sel: "#cm_save", title: "Save", desc: "Saves your automatic client messages." },
        ],
        automations: [
          { sel: "#autoCard", title: "Everything Helm does by itself", desc: "One list of every automatic message and task. Each one has its own on / off switch." },
          { sel: "#autoCard .au-grp", title: "Grouped by job", desc: "Client messages, team reminders and money alerts sit in their own groups." },
          { sel: "#autoCard .au-sw", title: "Switch one on or off", desc: "Tap the switch. It changes for the whole studio straight away." },
          { sel: "#rsrCard", title: "Run-sheet reminders", desc: "Remind the owner of each run-sheet item before it starts on the event day." },
          { sel: "#enqCard", title: "Enquiry form", desc: "Your public form for your website. Every enquiry becomes a new lead." },
        ],
        renders: [
          { sel: "#prCard", title: "Photo renders", desc: "Photo-like pictures of a floor plan, made from the builder." },
          { sel: "#pr_on", title: "On or off", desc: "Switch photo renders on for your studio." },
          { sel: "#pr_quota", title: "Monthly limit", desc: "How many renders the studio can make each month, and per hour." },
          { sel: "#pr_save", title: "Save", desc: "Saves the render settings." },
        ],
        crew: [
          { sel: "#crewCfgCard", title: "Crew & shifts", desc: "How your crew use their crew link: days off, open shifts and event-day check-in." },
          { sel: 'label[for="cc_av"]', title: "Days they can't work", desc: "Crew mark days off. You get a warning before you assign them that day." },
          { sel: 'label[for="cc_os"]', title: "Open shifts", desc: "Post a shift; crew take it from their crew link, first come or with your approval." },
          { sel: 'label[for="cc_ci"]', title: "Check in and out", desc: "Crew check in on the event day. You can ask that they are near the venue." },
          { sel: "#cc_pay", title: "Wages from check-in", desc: "Actual wages on the Budget page come from the hours or days crew checked in." },
          { sel: "#cc_save", title: "Save", desc: "Saves the crew settings. Only people who can edit Settings can change them." },
        ],
        venues: [
          { sel: "#venuesCard", title: "Your venues", desc: "Halls and spaces you work in, ready to pick when you make a quote or a floor plan." },
          { sel: "#vn_root .vn-tools", title: "Find or add", desc: "Search your venues, or add a new one." },
          { sel: "#vn_root .vn-list", title: "Area and capacity", desc: "Each venue keeps its usable floor area and how many guests it holds, so layouts fit the room." },
        ],
        ltemplates: [
          { sel: "#ltemplatesCard", title: "Layout templates", desc: "Floor layouts your team can start a new design from." },
          { sel: "#st_root", title: "Make and edit", desc: "Save a floor as a template from the builder, then rename or remove it here." },
        ],
      },
    },
    "crm.html": [
      { sel: "#search", title: "Search the archive", desc: "Find any past client by name, phone or event type for follow-up or a repeat booking." },
      { sel: "#fSource", title: "Filter", desc: "Narrow the list by where the client came from or the stage they reached." },
      { sel: "#fAll", title: "Full history", desc: "Show every snapshot of a client, not just the latest." },
      { sel: "#rows", title: "Client history", desc: "Every past client and enquiry, snapshotted automatically from Leads — nothing is ever lost." },
    ],
    "nurture.html": [
      { sel: "#addCard", title: "Add a relationship", desc: "Keep past clients warm — record birthdays and anniversaries to greet them automatically." },
      { sel: "#autoCard", title: "Automatic greetings", desc: "Switch greetings on, choose how many days ahead, or send today's now." },
      { sel: "#occBody", title: "Coming up", desc: "The birthdays and anniversaries due soon." },
      { sel: "#tplTabs", title: "Message templates", desc: "Set the greeting messages Helm sends, so repeat business comes to you." },
      { sel: "#libCard", title: "Ready-made messages", desc: "Pick a greeting from the library, try it on yourself, then use it." },
    ],
    "plan.html": [
      { sel: "#floorLink", title: "Floor layout", desc: "Open this event's floor plan in the builder." },
      { sel: "#v_name", title: "Venue details", desc: "The venue, the contact there and how to get equipment in." },
      { sel: "#pkgCards", title: "Pick a menu package", desc: "Choose the package for this event. Its price goes into the quote." },
      { sel: "#dishSearch", title: "Build the menu", desc: "Search the dish catalog and add items to this event's menu. The results list opens above the cards below it." },
      { sel: "#lockBtn", title: "Lock the plan", desc: "Once the menu and details are final, lock the plan so numbers don't drift before the event." },
    ],
    "runsheet.html": [
      { sel: "#rsIntro", title: "The event day, minute by minute", desc: "What happens when, who owns it and where." },
      { sel: "#planLock", title: "Locked for the event day", desc: "Once the plan is locked (by itself on the day, or Lock plan) the lines can't change here. An admin or the event manager can Unlock with a reason; it is kept in the history. Reminders still go." },
      { sel: "#r_add", title: "Add a run-sheet item", desc: "Build a timed schedule of the day — each moment, who owns it and when." },
      { sel: "#r_remWrap", title: "Reminders", desc: "Remind the owner before their item starts, and post it in the event group." },
      { sel: "#rows", title: "The schedule", desc: "Every item in time order. Click one to edit it." },
      { sel: "#printBtn", trial: false, title: "Print / share", desc: "Print the run-sheet or share it so everyone runs to the same timeline." },
    ],
    "command.html": [
      { sel: "#b_code", title: "Event day", desc: "The event you are running today, its venue and time." },
      { sel: "#dlvBoard", title: "Deliveries", desc: "What is arriving, from whom, and whether it has arrived." },
      { sel: "#pullBtn", title: "Pull the roster", desc: "Load the assigned staff for the day so you can check them in as they arrive." },
      { sel: "#chkAdd", title: "Day-of checklist", desc: "Tick tasks off live as the event runs." },
      { sel: "#gst_add", title: "Guests & stock", desc: "Check in guests and track stock used through the day." },
      { sel: "#l_issues", title: "Something went wrong?", desc: "Log an issue or incident so it is followed up after the event." },
    ],
    "closure.html": [
      { sel: "#moneyHeader", need: "finance", title: "Money at a glance", desc: "The final profit against your target, frozen once closed (Frozen v1, v2...). Tabs: Plan vs actual, Cash in & out by date, and Who owes what (bills, crew, pay-backs, GST)." },
      { sel: ["#frozenPnl", "#plCard"], need: "finance", title: "Frozen P&L", desc: "When you close the event Helm keeps a copy of the P&L that never changes. Re-open and close again, or a late adjustment, writes a new version showing what changed." },
      { sel: ["#moneyLedger", "#plCard"], title: "Profit and loss", desc: "What the event earned and cost, and the profit left. Costs well over the plan are flagged, and costs added on the event day with no estimate are tagged Unplanned." },
      { sel: "#crewAttendance", need: "finance", title: "Confirm attendance", desc: "Who worked and for how long, suggested from the crew check-ins. One tap confirms it, so the wages in the margin are final." },
      { sel: "#c_feedback", title: "Capture feedback", desc: "Record the client's feedback and a quotable testimonial for your marketing." },
      { sel: "#rateAdd", title: "Rate vendors & staff", desc: "Score who worked well so you know who to rebook next time." },
      { sel: "#closeChecklist", title: "Before you close", desc: "What still has to be done: stock back, money settled. Each line links to where to fix it." },
      { sel: "#closeBtn", title: "Close & archive", desc: "Once all equipment is returned, close the event. It moves to the Archive tab with a clean P&L." },
    ],
    "event.html": [
      { sel: "#evHead", title: "This event", desc: "Code, status, approval and total at a glance. Not confirmed yet? The note above says what is next - Continue where you left off goes there. Free trial: the approval link is a preview, nothing is sent." },
      { sel: "#nextStepBar", title: "What to do next", desc: "Helm tells you the next step and why. Tap it to go straight there." },
      { sel: "#steps", title: "The event lifecycle", desc: "Every stage of this event, from proposal to settlement. Click a step to jump straight to it." },
      { sel: "#advBtn", title: "Advance the stage", desc: "Move the event forward — discovery → proposal → quote → confirmed → planning, and on." },
      { sel: "#inviteBtn", title: "Invitation website", desc: "Once confirmed, build a public invitation site for the client to share with guests." },
      { sel: ["#moneyHeader", "#paySchedCard"], need: "finance", title: "Money at a glance", desc: "Quoted, received, costs and profit against your target with a traffic light, and what needs attention. The client's payment plan is just below." },
      { sel: "#filesPanel", title: "Files", desc: "Keep this event's papers in one place: contracts, permits, drawings." },
      { sel: "#evMenuBtn", title: "More actions", desc: "Share the booklet, re-share links, or cancel the event. Free trial: Share booklet (Preview) shows it inside your studio." },
    ],
    /* ---------------- pages added in R46: every app page has a tour ---------------- */
    "dashboard.html": { own: "#helpBtn" },   // the first-run tour (const TOUR in dashboard.html)
    "chat.html": [
      { sel: "#convSearch", title: "Find a chat", desc: "Search people, groups and event chats." },
      { sel: "#chips", title: "Filters", desc: "Show all chats, only unread, groups or event chats." },
      { sel: "#plusBtn", title: "Start a chat", desc: "Message one teammate or make a group." },
      { sel: "#convList", title: "Your chats", desc: "Every conversation, newest first. The small dot on a photo: green = online now, amber = away, grey = offline (hover for last active). Turn yours off in the ⋮ menu." },
      { sel: "#composer", title: "Write a message", desc: "Type, attach a photo or file, or record a voice note. @name tags a teammate." },
      { sel: "#searchBtn", title: "Search this chat", desc: "Find an old message in the open conversation." },
    ],
    "business.html": [
      { sel: ".bz-hero", title: "Money today", desc: "A one-line summary of what is booked, collected and still owed." },
      { sel: ".bz-snav", title: "Jump to a part", desc: "Go straight to overview, overdue payments, upcoming events or the pipeline." },
      { sel: ".bz-kpis", title: "Key numbers", desc: "Booked, collected and owed for the period, with the change from the last one. Tap a tile to open the list behind it." },
      { sel: "#bz-revenue", title: "Booked vs collected", desc: "Month by month: what you sold and what came in." },
      { sel: "#bz-overdue", title: "Overdue payments", desc: "Clients who owe you past their due date. Chase these first." },
      { sel: "#bz-pipeline", title: "Pipeline", desc: "Quotes still open, and what they are worth if they confirm." },
      { sel: "#mlkBiz", title: "GST and TDS by month", desc: "GST to pay (collected minus input credit) and client TDS still waiting for Form 16A, month by month, for your accountant." },
      { sel: "#bz-vb-due", need: "finance", title: "Vendor bills to pay", desc: "Bills due in the next 2 weeks or already late (copy them for WhatsApp), the TDS you kept back this year for your CA, and who Helm reminds about bills." },
    ],
    "insights.html": [
      { sel: "#rangeBar", title: "Pick a period", desc: "Every number on this page covers the dates you choose here." },
      { sel: "#evKpis", title: "Events", desc: "How many leads and events, and how many turned into bookings." },
      { sel: "#moneyKpis", title: "Money", desc: "Revenue, collected and outstanding for the period." },
      { sel: "#costsCard", title: "Costs & profit", desc: "What events cost you and the profit left, event by event." },
      { sel: "#benchCard", title: "Benchmarks", desc: "How you compare with your own target margin." },
      { sel: "#perEventCard", title: "Per event", desc: "Each event's revenue, cost and margin side by side." },
    ],
    "reports.html": [
      { sel: "#rangeBar", title: "Pick a period", desc: "Leads, events, P&L and settlements cover the dates you choose." },
      { sel: "#setlBasis", title: "Settlement dates", desc: "Count settlements by payment date or by event date." },
      { sel: "#printPL", title: "Print or save", desc: "Print the report or save it as a PDF for your accountant." },
      { sel: "#printArea", title: "The report", desc: "Your profit and loss, then each section below it." },
    ],
    "audit.html": [
      { sel: "#fEntity", title: "What changed", desc: "Filter by type: quotes, payments, users, settings and more." },
      { sel: "#fSearch", title: "Search", desc: "Find a change by name, code or person." },
      { sel: "#rows", title: "Every change, logged", desc: "Who changed what and when. Nothing here can be edited or deleted." },
      { sel: "#rows .ac-toggle", title: "One line per edit", desc: "A few minutes of editing one quote shows as one line. Show steps lists every change with its time. Helm (automatic) marks what Helm did by itself, like updating the lead." },
      { sel: "#refresh", title: "Refresh", desc: "Load the newest entries." },
    ],
    "inbox.html": [
      { sel: "#ibxTabs", title: "Unread, all, snoozed, done", desc: "Your notifications sorted like an e-mail inbox." },
      { sel: "#ibxChips", title: "Filter", desc: "Show only one kind: approvals, payments, mentions and so on." },
      { sel: "#ibxGroupBy", title: "Group", desc: "Group by day, by event or by kind." },
      { sel: "#ibxList", title: "Your notifications", desc: "Open one to go to it. Mark it done, or snooze it until later." },
      { sel: "#ibxReadAll", title: "Mark all read", desc: "Clear the unread count in one go." },
      { sel: "#ibxMail", title: "E-mail me", desc: "Get unread notifications by e-mail, straight away or once each morning." },
    ],
    "monitor.html": [
      { sel: ".mon-evpick", title: "Pick the event", desc: "Tap the event name to switch: today and the next 3 days first, then the rest of the month (or All events today). On the right: guests arrive, and the countdown or, on the day, a live clock." },
      { sel: "#monWins", title: "Before / Day before / On the day / Wrap-up", desc: "The same four steps on Tasks & Crew and the Event-day monitor, from your studio's clock (the note says why). On the day starts 1 hour before the first item; Wrap-up = the day is over. Flip it by hand any time." },
      { sel: ["#monLock", "#monFloor"], title: "Floor plan and the plan lock", desc: "The floor plan for the day: sizes, seats vs guests, aisles. 2D, 3D and Measure open view only; Print gives the event-day pack. Locked = no plan changes until an admin or the event manager unlocks with a reason." },
      { sel: "#monSummary", title: "How far along", desc: "The bar is the share of tasks done. Tap a count (Late, Waiting for a yes...) to see just those tasks." },
      { sel: "#monAlerts", title: "Late tasks", desc: "Every task whose start time has passed and is not started. A special task shows how far it has been escalated, for example Escalated to manager 3:10 PM." },
      { sel: "#monTabs", title: "Six ways to look", desc: "By staff, By work, By status, Leftover (not done yet), Check-in: who is on site, who checked out, who is late. Activity: every update. Filters (on a phone behind the Filters button) include My departments." },
      { sel: "#monOpenOps", title: "Change something", desc: "Open shows a task right here: who, times, latest start, the proof photo and its updates. Remind sends a bell, an e-mail or a WhatsApp. To reassign, schedule or cancel, use Edit in Tasks & Crew." },
      { sel: ["#monWall", ".mon-head-acts"], title: "Wall screen", desc: "Big text for a TV or a wall screen, full screen when the browser allows it. Press it again (or Exit wall screen) to go back." },
    ],
    "integrations.html": [
      { sel: "#itgEmail", title: "E-mail invites", desc: "The sender name and reply-to address on e-mails Helm sends for you. Changing the reply-to address needs two-step sign-in; the sender name does not." },
      { sel: "#itgEmailTest", title: "Test it", desc: "Send yourself a test e-mail to see how it looks." },
      { sel: "#itgWa", title: "WhatsApp", desc: "Your studio's own WhatsApp Business number. Proposals, approval codes, reminders and crew tasks go out from it." },
      { sel: "#itgWaConnect", title: "Connect your number", desc: "Paste your WhatsApp IDs and token, then check the connection. Save details keeps the two IDs without the token; the token is never shown again (Replace token puts in a new one)." },
      { sel: "#itgWaConnect", title: "Message templates", desc: "Template setup runs in the background - leave the page; a bell notice says when Meta is done. Rejected ones show why, with Fix and resubmit." },
    ],
    "client.html": [
      { sel: "#c_name", title: "One client, everything", desc: "This client's name, contact details and status." },
      { sel: "#c_totals", title: "Money", desc: "What you quoted them, what they paid and what is still due." },
      { sel: "#filters", title: "Filter the history", desc: "Show only quotes, events, payments or messages." },
      { sel: "#timeline", title: "Timeline", desc: "Everything that happened with this client, newest first." },
    ],
    "discovery.html": [
      { sel: "#flowResumeBanner", need: "edit:quotes", title: "Continue where you left off", desc: "Shown while this quote is not confirmed yet: what is next (and which steps were skipped). Continue where you left off takes you to that step; Not now hides it for the rest of this session." },
      { sel: "#d_date", title: "The discovery meeting", desc: "When you met the client, how, and who was there." },
      { sel: "#d_bmax", title: "Budget", desc: "The client's budget range. One budget per event, set in step 1." },
      { sel: "#d_notes", title: "Notes", desc: "What the client wants, in their words." },
      { sel: "#d_save", title: "Save", desc: "Saves the discovery notes." },
      { sel: "#r_service", title: "Requirements", desc: "List each service they need, how important it is and how many." },
      { sel: "#reqRows", title: "The list", desc: "The requirements so far. Resource planning pulls from this list." },
    ],
    "proposal.html": [
      { sel: "#flowResumeBanner", need: "edit:quotes", title: "Continue where you left off", desc: "Shown while this quote is not confirmed yet: what is next (and which steps were skipped). Continue where you left off takes you to that step; Not now hides it for the rest of this session." },
      { sel: "#p_concept", title: "The concept", desc: "Your idea for the event in a few lines: the story you are selling." },
      { sel: "#p_color", title: "Colours", desc: "Add the colour palette as swatches." },
      { sel: "#p_img", title: "Mood board", desc: "Add inspiration images by link." },
      { sel: "#p_scope", title: "What's included", desc: "List what the client gets." },
      { sel: "#pubBtn", title: "Publish", desc: "Make the proposal live and copy the client link. Free trial: Share proposal (Preview) shows what your client would get - no link is made." },
      { sel: "#rk_title", title: "Risks", desc: "Note what could go wrong and how you will handle it." },
    ],
    "resources.html": [
      { sel: "#needsTitle", title: "What this event needs", desc: "People, stock and services, and how much of each is covered." },
      { sel: "#rows", title: "Needs vs covered", desc: "Each need, and whether staff, inventory or a vendor covers it. Gaps are flagged." },
      { sel: "#n_kind", title: "Add a need", desc: "Add a person, an item or a service this event needs." },
      { sel: "#pullBtn", title: "Pull from discovery", desc: "Copy the requirements you noted in discovery into this list." },
      { sel: "#bookings", title: "Vendors", desc: "Outside vendors booked for this event." },
      { sel: "#bookBtn", title: "Assign a vendor", desc: "Send a vendor a request, or note a booking you made by phone." },
    ],
    "settlement.html": [
      { sel: ["#moneyHeader", "#t_rev"], title: "Money at a glance", desc: "Profit against your target and what needs attention. Cash in & out shows money by date and why cash left is not profit; Who owes what lists the client, vendor bills, crew and pay-backs." },
      { sel: "#payments", need: "finance", title: "Client payments", desc: "Every payment received against this event." },
      { sel: "#pay_amt", need: "finance", title: "Record a payment", desc: "Type the amount and record it. The balance updates straight away." },
      { sel: "#clientTds", need: "finance", title: "TDS deducted by the client", desc: "A company client kept 2% as TDS? Record it here: it counts as received, so the balance is clear and the event can close. Tick Form 16A when it comes in." },
      { sel: "#vendBody", title: "Vendors", desc: "What you owe each vendor for this event." },
      { sel: "#vendorBills", need: "finance", title: "Vendor bills", desc: "Each vendor bill and what is paid. Record payout takes the TDS you keep back too, so the bill counts as fully paid. Add the bill's photo later if it is missing. Once the event is closed, an admin adds a late bill with the reason." },
      { sel: "#e_who", title: "Expenses", desc: "Add staff claims and other costs paid out." },
      { sel: "#r_kind", title: "Refunds", desc: "Money returned to the client, or recovered, with a reason." },
    ],
    "budget.html": [
      { sel: ["#moneyHeader", "#t_rev"], title: "Money at a glance", desc: "Quoted, received, costs against the plan and the profit. The light compares the margin with your target: green on target, amber just below, red well below." },
      { sel: ["#moneyHeader", "#planMount"], need: "finance", title: "Plan vs actual", desc: "Each cost category against its plan, flagged when it goes well over; tap a row for the bills behind it. Cash in & out and Who owes what are the next tabs." },
      { sel: "#planMount", title: "Budget plan", desc: "The cost lines for this event, estimated and actual." },
      { sel: "#c_desc", title: "Add a cost", desc: "Add a cost line with its type, estimate and actual." },
      { sel: "#paySchedCard", need: "finance", title: "Payment schedule", desc: "The client's payment plan for this event. In the free trial, a payment the client simulated shows as Paid (test) with its TEST receipt - no real money." },
      { sel: "#chgBtn", title: "Change requests", desc: "The client wants something extra? Add it as a change so the price and cost update." },
    ],
    "ready.html": [
      { sel: "#hero", title: "Is the event ready?", desc: "A score from the checks below. Green means good to go." },
      { sel: "#checks", title: "The checks", desc: "Staff, stock, vendors, payments and the run-sheet. Each line links to where to fix it." },
      { sel: "#rsLink", title: "The run-sheet", desc: "Open the minute-by-minute plan for the day." },
      { sel: "#markBtn", title: "Mark ready", desc: "When every check passes, mark the event ready." },
    ],
    "ops.html": [
      { sel: "#evhead", title: "The event at a glance", desc: "Date, venue, guests, countdown, You supervise: Catering. Below: the plan lock bar (locked on the day; unlock = admin or event manager + a reason) and, Day before / On the day, the Floor plan with 2D, 3D, Measure (view only) and Print pack." },
      { sel: ["#view", "#work"], title: "Tasks by department", desc: "One card per department: each task with its person, time, status and Email / WhatsApp. Pick a Supervisor per department (Supervisor, Event manager or Admin) - they get a bell and its late alerts. + Add task adds work there." },
      { sel: ["#chips", "#tcQ"], title: "Find a task", desc: "Tap a chip (Late, Special, No one yet, Waiting for a yes, No time, QC to check...) - each shows its count. Search finds tasks and people; press / to jump to it." },
      { sel: "#addBtn", title: "Add & assign", desc: "Four steps: what, who (Free that day / Busy elsewhere / Day off), when (Day before, Event day or No time yet, reminders, Special) and tell them by email or WhatsApp. Once accepted, Reassign locks - use Cancel (a reason is required)." },
      { sel: "#tcPhase", title: "Event steps", desc: "Below the tasks: Before the event / Day before / On the day / Wrap-up, picked from your studio's clock. Day before: tick the checklist. Ready by: each set-up job's latest start. On the day: the run-sheet, issues and Mark event complete." },
      { sel: "#attn", title: "What needs you", desc: "Before: Ready for the day? with Fix. On the day: late tasks, can't-work requests and check-ins." },
      { sel: "#assignEmailWrap", title: "Send by email or WhatsApp", desc: "Ticked: the person gets their tasks by email. Tick Send on WhatsApp to send from your studio number too - if it isn't connected, Helm says so and nothing is sent." },
      { sel: "#trmLine", title: "Task reminders", desc: "Reminders go by email to each staff record address and on WhatsApp once connected. Change time in a task's panel sets its start time and reminders; tick tasks to move many at once." },
    ],
    "teardown.html": [
      { sel: "#invRows", title: "Stock coming back", desc: "Every item that went out, and whether it is back. Mark back: came back OK and damaged (the rest is missing), or tick Some are still out. Consumables: count what is left over - the rest was used." },
      { sel: "#ciLink", title: "Check items back in", desc: "Open Inventory for this event to mark items returned." },
      { sel: "#bkRows", title: "Vendors packing up", desc: "Vendor pickups and handovers." },
      { sel: "#tdRows", title: "Teardown tasks", desc: "Tick off each pack-down job." },
      { sel: "#td_title", title: "Add a task", desc: "Add anything else that has to happen before you leave the venue." },
    ],
    "media.html": [
      { sel: "#m_kind", title: "Add photos and videos", desc: "Pick whether it is a photo or a video from the event." },
      { sel: "#m_url", title: "Paste the link", desc: "Paste its link and add a caption, then Add." },
      { sel: "#galleryOnly", title: "Client gallery", desc: "Preview only what the client will see in their gallery." },
      { sel: "#mediaGrid", title: "Your media", desc: "Everything from this event." },
    ],
    "issues.html": [
      { sel: "#tabs", title: "Issues and incidents", desc: "Issues are problems to fix; incidents are things that happened (a guest hurt, damage)." },
      { sel: "#i_title", title: "Log one", desc: "Say what happened, how serious it is and who owns it." },
      { sel: "#list", title: "Open issues", desc: "Everything logged for this event. Close each one when it is sorted." },
      { sel: "#changeLink", title: "Charge the client", desc: "If the fix costs the client, add a change request in Budget." },
    ],
    "templates.html": [
      { sel: "#t_name", title: "Make a template", desc: "A checklist you reuse on every event: name it and pick its section." },
      { sel: "#t_items", title: "The tasks", desc: "One task per line." },
      { sel: "#t_save", title: "Save", desc: "Saves the template. Apply it from an event's logistics page." },
      { sel: "#tplList", title: "Your templates", desc: "Edit or remove the templates you made." },
    ],
    "design.html": [
      { sel: "#dsPurpose", title: "Design studio", desc: "Plan the look of an event: theme, colours, décor." },
      { sel: "#dsRelated", title: "What it is not", desc: "Floor templates live in Settings; this page is only for an event's look." },
      { sel: "#queueWrap", title: "Events to design", desc: "Confirmed events waiting for a design. Pick one to work on." },
      { sel: "#singleCard", title: "One event", desc: "The design of the event you opened: theme, colours and notes." },
    ],
    // r29 (#264): Refer a studio - the referral link, free months, referred studios and the rules
    "refer.html": [
      { sel: "#rfSoon", title: "Coming soon", desc: "Referrals are not switched on for your studio yet. This page fills in once they are." },
      { sel: "#rfLink", title: "Your referral link", desc: "Copy your link, or give another studio your code to type at sign-up." },
      { sel: ".rf-acts", title: "Share it yourself", desc: "Send it from your own WhatsApp or e-mail, or copy a ready message. Helm never contacts people for you." },
      { sel: ".rf-next", title: "Your free months", desc: "When a studio you referred pays (after the 14-day refund wait), your next billing month is free. Your upcoming free months are listed here." },
      { sel: "#rfStats", title: "Your numbers", desc: "How many studios you referred, how many are in progress and how many earned you a month." },
      { sel: "#rfTable", title: "Studios you referred", desc: "Each studio's status and what it means. Filter by In progress, Earned or Not qualified." },
      { sel: "#rfLedger", title: "Free month history", desc: "Every free month you earned and when it was used." },
      { sel: "#rfRules", title: "The rules", desc: "The main referral rules, with a link to the full terms." },
    ],
    "invite-studio.html": [
      // r34 (#270): 11 themes, the "RSVP & privacy" card (how guests reply, address privacy, footer brand) and guest replies
      { sel: "#tpls", title: "Pick a design", desc: "Choose one of the 11 themes for the invitation website. A sangeet or mehendi event starts on the Mehndi theme." },
      { sel: "#f_names", title: "The details", desc: "Names, headline, date, time and venue. The preview updates as you type." },
      { sel: "#rsvpModeGroup", title: "How guests reply", desc: "Phone & WhatsApp buttons (the default), an RSVP form where guests say Yes / Maybe / No and how many are coming, or both. With the form only, your number stays private." },
      { sel: "#addrGroup", title: "Address privacy", desc: "Show the full address and map to everyone with the link (the default), or only the venue name and city until a guest replies Yes or Maybe. This needs the RSVP form. Below it you choose whether the footer says “Made with Helm Studios”." },
      { sel: "#photos", title: "Photos, music & schedule", desc: "Add photos and choose how the background looks. Further down: a song for the site and the day's programme (ceremony, dinner, dancing)." },
      { sel: "#shareCard", title: "Send to client", desc: "Share the site link with the client. Free trial: Publish invitation (Preview) shows what they would get - no link is made and nothing is sent." },
      { sel: "#repliesCard", title: "Guest replies", desc: "With the RSVP form on, every reply lands here: who is coming, how many, and a CSV download. Shown once the site is published." },
      { sel: ["#pvToggle", "#pubBtn"], title: "Preview & publish", desc: "Check the live preview, then publish and copy the link for the client. Turn off link takes the site down again. Free trial: Publish invitation (Preview) walks through the template, full site, RSVP and guest view." },
    ],
    /* ---------------- pages with their own layout (no app shell) ---------------- */
    "hq.html": [
      { sel: "#navgBiz", side: "right", title: "Helm HQ", desc: "The console for Helm staff: studios, requests, billing and plans. To renew a studio use Activate plan: Record a payment adds the payment and invoice only." },
      { sel: "#gSearch", title: "Search studios and people", desc: "Find a studio by name or link, or a person by e-mail. A studio's client logins are never listed. Invoices are under Billing." },
      { sel: "#kpis", title: "Key numbers", desc: "New studios, monthly income, plan mix and the trial funnel." },
      { sel: "#attList", title: "Needs attention", desc: "Studios and requests waiting on HQ. Trial ends show the studio's own day. System health beside it says why if job history can't be read." },
      // R154e (0351): Suggestions = the in-app Suggestion box (status, +1, a reply the sender reads in the app)
      { sel: "#tab-requests", side: "right", title: "Requests", desc: "Plan requests, sales enquiries and suggestions from studios. Under Suggestions, filter by status, kind or text, see the +1 count, mark New / Planned / Done / Not now and write a reply the sender reads under My suggestions." },
      { sel: "#tab-staff", side: "right", title: "Staff access", desc: "Who on the Helm team can use HQ, and with which rights." },
      // r123a (0332): every HQ person - their own sign-ins
      { sel: "#tab-account", side: "right", title: "Where you're logged in", desc: "Every device signed in to HQ with your account: device, rough location, last active. Sign out one, or log out of all other devices." },
      // r39 (0288): owner-only card on the Staff access tab (shown there only)
      { sel: "#sgCard", title: "Google-only sign-in", desc: "Owner only: make every Helm staff member sign in to HQ with their helm.events Google account. Read the warning first and keep the emergency undo handy." },
    ],
    "hq-referrals.html": [
      // r118 (F-16): Helm HQ Referrals & partners (HQ staff only; the button sits in the top bar, shown only after the HQ gate)
      { sel: "#kpis", title: "Referral numbers", desc: "Referred studios, how many are waiting for review and the free months given, in USD at list price." },
      { sel: "#t-rev", title: "Needs review", desc: "Referrals the checks flagged. Approve or reject each one; every decision is written to the HQ log." },
      { sel: "#t-led", title: "Rewards ledger", desc: "Every free month earned, held, used or expired. Rewards are months of Helm, never cash." },
      { sel: "#t-par", title: "Partner codes", desc: "Marketing links and partner codes. Creating or switching one needs Owner / Admin and a fresh two-step code." },
      { sel: "#t-set", title: "Program rules", desc: "Hold days, caps and expiry. \"Run the daily job now\" applies free months and sends notices to studios, so it asks first." },
    ],
    "booklet.html": {
      signedIn: true,   // client-facing link: the tour button only shows for a signed-in studio member
      steps: [
        { sel: "#cover", title: "The client booklet", desc: "This is what your client sees when you share the booklet." },
        { sel: "#toc", title: "Contents", desc: "Jump to any part: details, layout, menu, quote, payments." },
        { sel: "#packages", title: "Packages", desc: "The client picks a menu package here (when the package choice is on)." },
        { sel: "#layout2d", title: "Floor plan", desc: "The 2D plan and 3D view you captured from the builder." },
        { sel: "#quote", title: "Quote", desc: "Every line of the quote and the total." },
        { sel: "#payments", title: "Payment milestones", desc: "The client's payment plan. In the free trial a simulated payment shows Paid (test) with its TEST receipt and nothing left to pay is shown as \u2014 (test): no real money." },
        { sel: "#printBtn", title: "Download PDF", desc: "The client can save or print the booklet." },
      ],
    },
  };

  // Settings hash -> section (same names control-split.js uses)
  const HASH = { "#general": "general", "#account": "general", "#studio": "general", "#billing": "billing", "#privacy-pin": "privacy", "#privacy": "privacy",
    "#client-links": "links", "#pricing": "pricing", "#payment-schedules": "payments", "#payment-schedule": "payments", "#menu": "catalog", "#catalog": "catalog",
    "#layout-rules": "rules", "#data": "data", "#users": "users", "#team": "users", "#access": "access", "#compliance": "compliance",
    "#notifications": "notify", "#notify": "notify", "#reminders": "reminders", "#automations": "automations", "#renders": "renders", "#crew": "crew",
    "#venues": "venues", "#layout-templates": "ltemplates", "#ltemplates": "ltemplates" };

  function norm(page) { const p = String(page || "").toLowerCase().replace(/^\//, ""); return /\.html$/.test(p) ? p : p + ".html"; }
  function entry(page) { return TOURS[norm(page)] || null; }
  // the section key for a sectioned page right now (or null)
  function sectionOf(page) {
    const e = entry(page);
    if (!e || !e.sections) return null;
    let k = null; try { k = typeof e.section === "function" ? e.section() : null; } catch (_) { k = null; }
    return k && e.sections[k] ? k : (e.fallback || null);
  }
  // the steps for a page (and section) right now; [] when the page has none / runs its own
  function stepsFor(page, section) {
    const e = entry(page);
    if (!e) return [];
    if (Array.isArray(e)) return e;
    if (Array.isArray(e.steps)) return e.steps;
    if (e.sections) { const k = section || sectionOf(page); return (k && e.sections[k]) || []; }
    return [];
  }
  // localStorage key that remembers "seen" for this page / section
  function seenKey(page, section) {
    const base = norm(page).replace(/\.html$/, "").replace(/[^a-z0-9-]/g, "");
    return "helm_tour_seen_" + base + (section ? "_" + String(section).replace(/[^a-z0-9-]/gi, "") : "");
  }
  root.HelmPageTours = { TOURS, HASH, entry, stepsFor, sectionOf, seenKey, norm };
})(typeof window !== "undefined" ? window : globalThis);
