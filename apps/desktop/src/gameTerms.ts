/** The names game providers write (maps, modes, objectives, the units that kill you), in the
 *  player's language.
 *
 *  Rust stores what a game reports in `sessions.db` as the providers spell it: English, already
 *  made readable for League and Valorant ("Baron Nashor (stolen)", "Summoner's Rift",
 *  "Competitive"), and raw GSI values for Counter-Strike ("de_ancient", "competitive"). Rows keep
 *  those spellings for as long as the session exists, so translating when they are written
 *  would leave every older match in English, and a language switch would not reach them either.
 *  The UI translates when it draws instead, and the Rust spellings are the keys of the tables
 *  below: a provider that renames something must add the new spelling here and keep the old
 *  one for the rows already on disk.
 *
 *  Anything not in a table comes back as Rust wrote it. Champion, agent and player names and
 *  Valorant's maps are proper nouns, and a mode a provider did not know is only capitalised
 *  there, which reads better than a guess. Names spelled the same in every language (ARAM, URF,
 *  ARURF, Arena, Tutorial, Valorant's Premier) have no entry either. */

import { t, type Key } from "./i18n";

/** Maps, including the stray raw values that already read well. Maps, not records, so a name
 *  like "constructor" cannot find something on `Object.prototype`. */
const MAPS = new Map<string, Key>([
  // league::map_name
  ["Summoner's Rift", "game.map.summonersRift"],
  ["Howling Abyss", "game.map.howlingAbyss"],
  ["Nexus Blitz", "game.map.nexusBlitz"],
  ["Rings of Wrath", "game.map.ringsOfWrath"],
  // valorant::map_name; the range never starts a match, but the name exists.
  ["The Range", "game.map.theRange"],
]);

const MODES = new Map<string, Key>([
  // league::mode_name
  ["Classic", "game.mode.classic"],
  ["One for All", "game.mode.oneForAll"],
  ["Nexus Blitz", "game.mode.nexusBlitz"],
  ["Practice Tool", "game.mode.practiceTool"],
  ["Swiftplay", "game.mode.swiftplay"],
  ["Ultimate Spellbook", "game.mode.ultimateSpellbook"],
  ["Swarm", "game.mode.swarm"],
  // The capitalised fallback for `KIWI`, which the API reports for ARAM: Mayhem.
  ["Kiwi", "game.mode.aramMayhem"],
  // valorant::mode_name ("Swiftplay" is shared with League above)
  ["Competitive", "game.mode.competitive"],
  ["Unrated", "game.mode.unrated"],
  ["Spike Rush", "game.mode.spikeRush"],
  ["Deathmatch", "game.mode.deathmatch"],
  ["Escalation", "game.mode.escalation"],
  ["Replication", "game.mode.replication"],
  ["Team Deathmatch", "game.mode.teamDeathmatch"],
  ["Snowball Fight", "game.mode.snowballFight"],
  ["New Map", "game.mode.newMap"],
  ["Custom", "game.mode.custom"],
  ["Unknown mode", "game.mode.unknown"],
  // counter_strike.rs stores GSI's `map.mode` untouched.
  ["casual", "game.mode.casual"],
  ["competitive", "game.mode.competitive"],
  ["premier", "game.mode.premier"],
  ["scrimcomp2v2", "game.mode.wingman"],
  ["deathmatch", "game.mode.deathmatch"],
  ["gungameprogressive", "game.mode.armsRace"],
  ["gungametrbomb", "game.mode.demolition"],
  ["survival", "game.mode.dangerZone"],
  ["skirmish", "game.mode.warGames"],
  ["coopmission", "game.mode.guardian"],
  ["cooperative", "game.mode.coop"],
  ["training", "game.mode.training"],
  ["custom", "game.mode.custom"],
]);

/** league::translate. Counter-Strike and Valorant write no objectives. */
const OBJECTIVES = new Map<string, Key>([
  ["Ace", "game.objective.ace"],
  // `DragonKill` is "<DragonType> Dragon", or "Dragon" when the API left the type out.
  ["Dragon", "game.objective.dragon"],
  ["Fire Dragon", "game.objective.infernalDrake"],
  ["Water Dragon", "game.objective.oceanDrake"],
  ["Earth Dragon", "game.objective.mountainDrake"],
  ["Air Dragon", "game.objective.cloudDrake"],
  ["Hextech Dragon", "game.objective.hextechDrake"],
  ["Chemtech Dragon", "game.objective.chemtechDrake"],
  ["Elder Dragon", "game.objective.elderDragon"],
  ["Rift Herald", "game.objective.riftHerald"],
  ["Baron Nashor", "game.objective.baronNashor"],
  ["Voidgrubs", "game.objective.voidgrubs"],
  ["Tower", "game.objective.tower"],
  ["Inhibitor", "game.objective.inhibitor"],
]);

/** league::Snapshot::who for a killer or victim that is not a champion. */
const UNITS = new Map<string, Key>([
  ["a tower", "game.unit.tower"],
  ["minions", "game.unit.minions"],
]);

/** What league.rs appends to a dragon, the herald or the baron taken by the other team. */
const STOLEN = " (stolen)";

/** Counter-Strike map files: `de_` defusal, `cs_` hostage, `ar_` arms race, and the rest, maybe
 *  behind a workshop path. */
const CS_MAP = /^(?:workshop\/\d+\/)?(?:de|cs|ar|dz|gd|dm|aim|fy|coop|mg)_([a-z0-9_]+)$/i;

/** Where the file name and the map's name part ways. */
const CS_MAP_NAMES = new Map<string, string>([["dust2", "Dust II"]]);

function readableCsMap(raw: string): string | null {
  const m = CS_MAP.exec(raw);
  if (!m) return null;
  const name = m[1].toLowerCase();
  return (
    CS_MAP_NAMES.get(name) ??
    name
      .split("_")
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

/** A match's map: League's in the player's language, Counter-Strike's file name as the map's
 *  name ("de_ancient" is "Ancient"), Valorant's as it is. */
export function mapLabel(map: string | null): string | null {
  if (map === null) return null;
  const key = MAPS.get(map);
  if (key) return t(key);
  return readableCsMap(map) ?? map;
}

/** A match's mode, from any of the three providers. */
export function modeLabel(mode: string | null): string | null {
  if (mode === null) return null;
  const key = MODES.get(mode);
  return key ? t(key) : mode;
}

/** An objective event's name: "Baron Nashor (stolen)" is "Barón Nashor (robado)". */
export function objectiveLabel(name: string): string {
  const stolen = name.endsWith(STOLEN);
  const key = OBJECTIVES.get(stolen ? name.slice(0, -STOLEN.length) : name);
  if (!key) return name;
  return stolen ? t("game.stolen", { name: t(key) }) : t(key);
}

/** A kill's victim or a death's killer: a champion or a player stays as it is, the units League
 *  names ("a tower", "minions") are translated. */
export function unitLabel(name: string | null): string | null {
  if (name === null) return null;
  const key = UNITS.get(name);
  return key ? t(key) : name;
}
