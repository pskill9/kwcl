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

  apiUrl: "https://script.google.com/macros/s/AKfycbxU7SJBAKsxjOhSvkjrKogFtxhl00P6nQUES2u31BDCU8uG7je1RGP5ph2d5ljTN1Ug/exec",

  icon: "assets/crest.png",

  theme: {
    accentA: "#cd2e3a",   // taegeuk red
    accentB: "#3069c9",   // taegeuk blue
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
