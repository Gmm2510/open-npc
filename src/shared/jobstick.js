// Once the companion is on a job the player asked for, only the player's own words take it off that job.
(function () {

  const ALWAYS = new Set(['none', 'flee', 'emote', 'leave_it', 'remember_place', 'house_rule', 'forget_place']);

  const MOVES = new Set(['follow', 'come', 'stay', 'attack', 'guard', 'pick_up', 'stop_task', 'go_there', 'go_home', 'lead_back',
    'recover_items', 'kill_that', 'protect', 'fall_back', 'race', 'spar']);

  const CALL_RE = /\b(come|coming|follow|over here|this way|let'?s (go|head|move|bounce|dip|roll)|with me|get over here|stop|quit|cancel|forget (it|that|about (it|that))|never ?mind|nvm|leave (it|that|this)|enough|drop (it|that|this)|hurry|run|help|back off|fall back|stay|wait (here|there|up|for me)|hold (up|on)|go (there|home|back|over)|kill|fight|attack|protect|guard|defend|behind you|watch out|save me|race|spar)\b/i;

  function calls(text) { return CALL_RE.test(String(text || '')); }

  function keepJob(name, meta, { isJob = false } = {}) {
    if (!name || ALWAYS.has(name)) return false;
    const m = meta && typeof meta === 'object' ? meta : {};
    if (m.src === 'player') {
      if (MOVES.has(name)) return !calls(m.text);
      return false;
    }

    return MOVES.has(name) || isJob;
  }

  function metaFor(trigger) {
    const k = trigger && trigger.kind;
    if (k === 'player' || k === 'typed') return { src: 'player', text: String(trigger.text || '').slice(0, 300) };
    return { src: 'auto' };
  }

  function jobNow(gameState) {
    const d = gameState && typeof gameState.you_are_doing === 'string' ? gameState.you_are_doing : '';
    const m = /^(.*) \(for \d+s\)$/.exec(d);
    return m ? m[1] : null;
  }

  const api = { keepJob, metaFor, calls, jobNow, ALWAYS, MOVES, CALL_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.GGJobStick = api;
})();
