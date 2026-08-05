/* =============================================================
   ALLIANCE CONFIG
   =============================================================
   This is the only file another alliance needs to edit.
   Fork the repo, change the values below, push — done.

   - apiUrl: your Google Apps Script Web app URL (same API shape:
     ?action=sheets and ?action=data&sheet=YYYY-MM-DD returning
     rows of { Rank, Commander, Tier, Power }).
   - icon: path to your crest image (or null to hide it).
   - theme: the two accent colors used for section rules & chips.
   - charter: your rules section (or null to hide the section).
   - strings: heading translations. Every key is OPTIONAL — leave
     a key out and the site shows its built-in English label.
     Each value is either:
       "Plain text"                          → shown as-is
       { local: "현지어", en: "English" }     → shown as "현지어 · ENGLISH"

   Minimal English-only example:

   window.ALLIANCE_CONFIG = {
     name: "MyAlly",
     fullName: "My Alliance",
     game: "Last War: Survival",
     apiUrl: "https://script.google.com/macros/s/YOUR_ID/exec",
     icon: null,
     theme: { accentA: "#d03b3b", accentB: "#2a78d6" },
     charter: null,
     strings: {},
   };
   ============================================================= */

window.ALLIANCE_CONFIG = {
  name: "kWcl",
  fullName: "Korea World Class",
  localName: "코리아 월드 클래스",
  game: "Last War: Survival",

  apiUrl: "https://script.google.com/macros/s/AKfycbyt0Uiq-evzLOdYG4bfiLWfNOK__R2txYUNkAltJLxQelBqJ0AeTOKdXVrjN3pDywSC/exec",

  icon: "assets/crest.png",

  theme: {
    accentA: "#cd2e3a",   // taegeuk red
    accentB: "#3069c9",   // taegeuk blue
  },

  /* Browser push notifications.

     publicKey is the VAPID public half. It is PUBLIC by design — every
     visitor's browser needs it to create a subscription, so it belongs in the
     repo. The private half lives in the Apps Script property VAPID_PRIVATE.

     Never change this pair. The public key is baked into every subscription
     any browser has ever created for this site; replacing it invalidates all
     of them silently, with no error shown anywhere, and everyone has to
     subscribe again. */
  push: {
    enabled: true,
    publicKey: "BKCJ5L3ojpXpsafFb9rr79lU55J7WIsyydylGOwi6WCh1EVr7Rsz4TYH0EAH4T89SZoNzxigjz6ECHAsjtupfoA",
  },

  /* Shoutouts — short, time-limited messages posted from admin.html.
     Reword or add templates freely; nothing here is referenced by name in
     the code. `text` is only a starting point, the admin edits it before
     posting. The password is NOT here — it lives in the Apps Script
     property CALLOUT_SECRET, which the browser never sees. */
  callouts: {
    sheet: "Shoutouts",

    /* The first template of each type is pre-selected in the composer, so
       posting is one edit away. Add, reword or reorder freely. */
    templates: [
      {
        type: "announcement",
        label: "Event announcement",
        text: "Alliance event — \nWhen: \nWhat to do: ",
      },
      {
        type: "announcement",
        label: "Reminder",
        text: "Reminder — \nDeadline: ",
      },
      {
        type: "shoutout",
        label: "Great performance",
        text: "Outstanding work this week — ",
      },
      {
        type: "shoutout",
        label: "Thanks for the help",
        text: "Thank you for stepping in — ",
      },
    ],

    /* Badges an admin can pin to a shoutout. `key` is what gets stored in the
       sheet, so renaming a label is safe but changing a key orphans the badge
       on older rows (they simply render without one). Icons are plain emoji —
       no assets to ship. */
    badges: [
      { key: "treasure",    icon: "💰", label: "Treasure" },
      { key: "extinguisher", icon: "🧯", label: "Fire extinguisher" },
      { key: "helper",      icon: "🤝", label: "Helper" },
      { key: "healer",      icon: "💚", label: "Healer" },
      { key: "defender",    icon: "🛡️", label: "Defender" },
      { key: "rally",       icon: "⚔️", label: "Rally lead" },
      { key: "builder",     icon: "🏗️", label: "Builder" },
    ],
  },

  charter: {
    lead: "We move forward in step with all team members. Please enjoy the game with good manners and an altruistic attitude.",
    rules: [
      { label: "일일 VS · Daily VS points", value: "7.2M", note: "every day, mandatory" },
      { label: "연맹 기부 · Alliance donation", value: "Mandatory" },
      { label: "집결 이동 · Gathering point", value: "Mandatory", note: "move when called" },
      { label: "접속 · Activity", value: "Daily login", note: "long-term members only" },
      { label: "협정 · Non-aggression", value: "2254 NAP-20" },
    ],
    join: "가입 문의 · To join: contact the recruiter or any R4. Please only apply if you can log in every day and intend to stay with us for a long time.",
  },

  footerMotto: "2254 NAP-20 · 함께 전진 · We move forward together",

  strings: {
    situationBoard: { local: "상황판", en: "Situation board" },
    heroTitle: "Alliance Headquarters",
    allianceChart: { local: "연맹 전투력", en: "Alliance total power" },
    statTotalPower: { local: "총 전투력", en: "Total power" },
    statGrowth7d: { local: "7일 성장", en: "7-day growth" },
    statCommanders: { local: "지휘관", en: "Commanders" },
    statAvgPower: { local: "평균 전투력", en: "Avg power" },
    charter: { local: "연맹 강령", en: "Alliance charter" },
    newcomers: { local: "새 식구", en: "New arrivals" },
    welcomeNote: { local: "오늘 합류했습니다. 반갑습니다!", en: "Joined today — say hello." },
    hallOfFame: { local: "명예의 전당", en: "Hall of fame" },
    movers: { local: "전력 변동", en: "Movers" },
    roster: { local: "서열표", en: "Roster" },
    dossier: { local: "지휘관 기록", en: "Commander dossier" },
    powerOverTime: { local: "전투력 추이", en: "Power over time" },
    rankOverTime: { local: "서열 추이", en: "Rank over time (1 = top)" },
    compare: { local: "비교 분석", en: "Compare commanders" },
    tiers: { local: "계급 구성", en: "Tier breakdown" },
    /* Untranslated keys fall back to English, e.g.:
       topGainers, declining, thRank, thCommander, thTier, thPower,
       th24h, th7d, thTrend, thMembers, thTotalPower, thAvgPower,
       thShare, searchPlaceholder, addCommander, addBtn, rosterHint,
       modePower, modeIndexed, compareHintPower, compareHintIndexed,
       noGains, noDeclines, needTwo, factRank, factBestRank, factPower,
       factGrowth7d, factTotalGrowth, factAvgDay, factFirstSeen,
       factSnapshots */
  },
};
