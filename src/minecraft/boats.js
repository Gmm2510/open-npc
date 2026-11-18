// Boats: rides in yours, or puts its own on the water (making one first if it has none) and follows you by boat.
const { Vec3 } = require('vec3');
const { goals: { GoalNear } } = require('mineflayer-pathfinder');
const { Nope } = require('./skills');

const BOAT_ITEM_RE = /_(boat|raft)$/;
const BOAT_ENTITY_RE = /(^|_)(boat|raft)$/i;
const STEP = 0.3;
const NEAR = 3.5;
const SHORE_GIVE_UP_MS = 3000;
const isBoat = (e) => !!(e && BOAT_ENTITY_RE.test(String(e.name || '')));

function nextStep(pos, target, { waterAt, solidAt, step = STEP, near = NEAR } = {}) {
  const dx = target.x - pos.x, dz = target.z - pos.z;
  const d = Math.hypot(dx, dz);
  if (d <= near) return { idle: true, d };
  const s = Math.min(step, d - near + 0.05);
  const ux = dx / d, uz = dz / d;
  const nx = pos.x + ux * s, nz = pos.z + uz * s;

  const probes = [[ux * 0.8, uz * 0.8], [ux * 0.6 - uz * 0.6, uz * 0.6 + ux * 0.6], [ux * 0.6 + uz * 0.6, uz * 0.6 - ux * 0.6]];
  for (const [ox, oz] of probes) {
    const px = nx + ox, pz = nz + oz;
    if (!waterAt(px, pos.y - 0.4, pz)) return { blocked: 'land', d };
    if (solidAt(px, pos.y + 0.3, pz)) return { blocked: 'block', d };
  }
  const yaw = Math.atan2(-ux, uz) * 180 / Math.PI;
  return { x: nx, y: pos.y, z: nz, yaw, d };
}

class Boats {
  constructor(c) {
    this.c = c;
    this.ride = null;
    this.ownBoatId = null;
    c.addTask('ride_boat', { label: 'getting in a boat', run: (s, a) => this.rideJob(s, a) });
    c.addTask('leave_boat', { label: 'getting out of the boat', run: (s, a) => this.leaveJob(s, a) });
  }

  on() { return this.c.f('boats'); }

  command(name) {
    if (name !== 'ride_boat' && name !== 'leave_boat') return null;
    if (!this.on()) return { ok: false, reason: 'not_available' };
    return null;
  }

  async rideJob(s) {
    if (!this.on()) throw new Nope("you can't use boats yet");
    const bot = this.c.bot;
    if (isBoat(bot.vehicle)) { this.startRide(bot.vehicle, this.ownBoatId === bot.vehicle.id); return 'already in a boat'; }
    const owner = this.c.ownerEntity();
    if (!owner) throw new Nope("you can't see the player from where you are");

    const theirs = isBoat(owner.vehicle) ? owner.vehicle : null;
    if (theirs && (theirs.passengers || []).length < 2 && !/chest/.test(String(theirs.name || ''))) {
      await s.gotoNear(theirs.position, 2, { dig: false, timeout: 15000 }).catch(() => {});
      if (await this.mount(theirs)) { this.startRide(theirs, false); return "you are in the player's boat with them"; }
    }

    let item = this.boatItem();
    if (!item) {
      const hands = this.c.v12.hands;
      if (!hands || !hands.cmd || typeof hands.cmd.craftItemJob !== 'function') throw new Nope("you don't have a boat on you");
      const wood = this.woodOnHand() || 'oak';
      await hands.cmd.craftItemJob(s, { item: `${wood}_boat`, n: 1, keep: true });
      item = this.boatItem();
      if (!item) throw new Nope("you couldn't make a boat");
    }
    const water = this.waterNear(owner.position);
    if (!water) throw new Nope("there's no open water right by the player");
    await s.gotoNear(water.position.offset(0, 1, 0), 3, { dig: false, timeout: 20000 });
    await bot.equip(item, 'hand');
    let boat = null;
    for (const w of [water, ...this.waterNearAll(bot.entity.position, 4).filter((b) => !b.position.equals(water.position)).slice(0, 2)]) {
      try { boat = await bot.placeEntity(w, new Vec3(0, 1, 0)); break; } catch { boat = null; }
    }
    if (!boat) throw new Nope("the boat wouldn't go down on the water");
    this.ownBoatId = boat.id;
    if (!(await this.mount(boat))) throw new Nope("you put the boat down but couldn't get in");
    this.startRide(boat, true);
    return 'put your boat on the water and got in';
  }

  async mount(boat) {
    const bot = this.c.bot;
    for (let i = 0; i < 2; i++) {
      try { bot.mount(boat); } catch {}
      for (let k = 0; k < 20; k++) {
        await new Promise((r) => setTimeout(r, 100));
        if (bot.vehicle && bot.vehicle.id === boat.id) return true;
      }
    }
    return false;
  }

  boatItem() {
    return (this.c.bot.inventory.items() || []).find((i) => BOAT_ITEM_RE.test(i.name)) || null;
  }

  woodOnHand() {
    const it = (this.c.bot.inventory.items() || []).find((i) => /_(planks|log)$/.test(i.name) && !/stripped/.test(i.name));
    if (!it) return null;
    const w = it.name.replace(/_(planks|log)$/, '');
    return w === 'bamboo' ? null : w;
  }

  waterNearAll(at, range = 8) {
    const bot = this.c.bot;
    const ids = ['water'].map((n) => bot.registry.blocksByName[n]).filter(Boolean).map((b) => b.id);
    if (!ids.length) return [];
    const ps = bot.findBlocks({ matching: ids, maxDistance: range, count: 64, point: at }) || [];
    const out = [];
    for (const p of ps) {
      const above = bot.blockAt(p.offset(0, 1, 0));
      if (above && above.name === 'air') { const b = bot.blockAt(p); if (b) out.push(b); }
    }
    return out.sort((a, b) => a.position.distanceTo(at) - b.position.distanceTo(at));
  }
  waterNear(at) { return this.waterNearAll(at, 8)[0] || null; }

  startRide(boat, own) {
    this.stopRide();
    const bot = this.c.bot;
    try { bot.pathfinder.setGoal(null); } catch {}
    this.ride = { boat, own, driving: !!(own || (boat.passengers || [])[0] === bot.entity), blockedSince: 0, last: null };

    this.ride.physics = bot.physicsEnabled !== false;
    bot.physicsEnabled = false;
    this.c.emit('log', `in a boat (${own ? 'your own, you steer' : "the player's, the player steers"})`);
    const onMove = (p) => { if (this.ride && this.ride.boat) this.ride.boat.position.set(p.x, p.y, p.z); };
    this.ride.onMove = onMove;
    try { bot._client.on('vehicle_move', onMove); } catch {}
    this.ride.timer = setInterval(() => { try { this.steer(Date.now()); } catch (err) { this.c.emit('log', `boat: ${err.message}`); } }, 50);
  }

  stopRide() {
    const r = this.ride;
    if (!r) return;
    clearInterval(r.timer);
    try { this.c.bot._client.removeListener('vehicle_move', r.onMove); } catch {}
    if (this.c.bot) this.c.bot.physicsEnabled = r.physics !== false;
    this.ride = null;
  }

  steer(now) {
    const r = this.ride, bot = this.c.bot;
    if (!r) return;
    if (!bot || !bot.vehicle || bot.vehicle.id !== r.boat.id) { this.stopRide(); return; }
    const owner = this.c.ownerEntity();

    if (!r.own && owner && !(owner.vehicle && owner.vehicle.id === r.boat.id)) { this.getOut(); return; }

    try { bot.entity.position.set(r.boat.position.x, r.boat.position.y + 0.45, r.boat.position.z); } catch {}
    if (!r.own || !owner || this.c.mode === 'stay') return;
    const world = {
      waterAt: (x, y, z) => { const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); return !!(b && (b.name === 'water' || b.name === 'bubble_column' || /waterlogged/.test(JSON.stringify(b.getProperties ? b.getProperties() : {})))); },
      solidAt: (x, y, z) => { const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); return !!(b && b.boundingBox === 'block'); }
    };
    const target = owner.vehicle && isBoat(owner.vehicle) ? owner.vehicle.position : owner.position;
    const n = nextStep(r.boat.position, target, world);
    if (n.idle) { r.blockedSince = 0; return; }
    if (n.blocked) {
      r.blockedSince = r.blockedSince || now;

      const theyOnLand = !owner.vehicle && !this.inWater(owner.position);
      if (theyOnLand && now - r.blockedSince > SHORE_GIVE_UP_MS) { this.getOut(); }
      return;
    }
    r.blockedSince = 0;
    r.boat.position.set(n.x, n.y, n.z);
    const yaw = n.yaw;
    try {
      bot._client.write('vehicle_move', { x: n.x, y: n.y, z: n.z, yaw, pitch: 0, onGround: false });
      bot._client.write('steer_boat', { leftPaddle: true, rightPaddle: true });
    } catch (err) { this.c.emit('log', `boat move: ${err.message}`); }
  }

  inWater(p) {
    const b = this.c.bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
    return !!(b && b.name === 'water');
  }

  getOut() {
    const r = this.ride, bot = this.c.bot;
    const own = !!(r && r.own), boat = r && r.boat;
    this.stopRide();
    try { bot.dismount(); } catch {}
    this.c.setMode('follow', 0);
    if (own && boat) setTimeout(() => this.takeBack(boat).catch(() => {}), 600);
  }

  async takeBack(boat) {
    const bot = this.c.bot;
    for (let i = 0; i < 6; i++) {
      const e = bot.entities[boat.id];
      if (!e || !e.isValid) break;
      try { await bot.lookAt(e.position.offset(0, 0.3, 0)); bot.attack(e); } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    this.ownBoatId = null;
    await new Promise((r) => setTimeout(r, 400));
    try { this.c.command('pick_up', {}, null); } catch {}
  }

  async leaveJob() {
    const bot = this.c.bot;
    if (!bot.vehicle) { if (this.ride) this.stopRide(); return 'not in a boat'; }
    const own = !!(this.ride && this.ride.own);
    this.getOut();
    await new Promise((r) => setTimeout(r, 2500));
    return own ? 'got out and picked your boat back up' : "got out of the player's boat";
  }

  takeOver() { return !!(this.ride && this.c.bot && this.c.bot.vehicle); }
  onLeave() { this.stopRide(); this.ownBoatId = null; }
  onFeatures(f) { if (!f || !f.boats) { if (this.ride) this.getOut(); } }
  state() {
    if (!this.on()) return null;
    const v = this.c.bot && this.c.bot.vehicle;
    return { in_boat: !!(v && isBoat(v)), ...(v && isBoat(v) ? { boat: this.ride && this.ride.own ? 'your own, you steer' : "the player's, the player steers" } : {}) };
  }
}

module.exports = { Boats, nextStep, isBoat, BOAT_ITEM_RE };
