// Which of the body's abilities are on. These are the settings the body was tuned and played with; each module checks its own
// switch, so turning one off here takes that ability out without touching the rest.
module.exports = Object.freeze({
  // what the AI can ask for
  commands: true, builder: true, miniGames: true, freeBuild: true, leanCommands: true, boats: true, toolHands: true,
  initiative: false, memory2: false,
  // how the body moves and reacts
  humanizer: true, perception: true, gameAwareness: true, socialBody: true, seeBuilds: true, jobsStick: true,
  followGap: true, movesStill: true, reactions: false, mood: false, humor: false,
  // how jobs are carried out
  bodyBaseGround: true, bodyCoach: true, bodyFooting: true, bodyFuel: true, bodyHandover: true, bodyLeaves: true,
  bodyLevel: true, bodyNoHarm: true, bodyOre: false, bodyReach: true, bodyRoam: true, bodyToss: true, bodyTower: true,
  bodyWood: true,
  // playing on its own while the owner is away
  bodySolo: true, bodySoloAir: true, bodySoloBreathe: true, bodySoloCave: true, bodySoloCaves: true, bodySoloClimb: true,
  bodySoloDay: true, bodySoloFarm: true, bodySoloMem: true, bodySoloMem2: true, bodySoloNight: true, bodySoloNight2: true,
  bodySoloNight3: true, bodySoloOre: true, bodySoloSafe: true, bodySoloWater: true
});
