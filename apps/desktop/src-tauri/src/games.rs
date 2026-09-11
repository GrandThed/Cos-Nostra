//! Guesses which game a clip belongs to from the foreground window at save time.
//!
//! Detection is deliberately dumb: an executable-name table for the games the community
//! actually plays, a cleaned-up window title for everything else, and a short list of
//! programs that are never games so a clip saved from the desktop is not labelled
//! "Program Manager".

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DetectedGame {
    /// Display name, e.g. "Counter-Strike 2". From the table when known, otherwise derived
    /// from the window title.
    pub game: String,
    pub executable: String,
    pub title: String,
    /// True when the executable was found in the known-games table.
    pub confident: bool,
}

/// Looks at the foreground window. Returns `None` when it is not a game (browser, editor,
/// our own window, the desktop...).
pub fn detect_foreground() -> Option<DetectedGame> {
    let fg = crate::win::foreground_window()?;
    if is_non_game(&fg.executable) {
        return None;
    }
    let confident = table_lookup(&fg.executable).is_some();
    let game = name_for(&fg.executable, &fg.title).or_else(|| {
        let stem = exe_stem(&fg.executable);
        (!stem.is_empty()).then(|| stem.to_string())
    })?;
    Some(DetectedGame {
        game,
        executable: fg.executable,
        title: fg.title,
        confident,
    })
}

/// Table lookup by executable file name (case-insensitive), falling back to a cleaned-up
/// window title. `None` when neither gives anything usable.
pub fn name_for(executable: &str, title: &str) -> Option<String> {
    if is_non_game(executable) {
        return None;
    }
    if let Some(name) = table_lookup(executable) {
        return Some(name.to_string());
    }
    let cleaned = clean_title(title);
    (!cleaned.is_empty()).then_some(cleaned)
}

/// True when the executable is in the known-games table, i.e. the name is not a guess made
/// from a window title. Mirrors what `detect_foreground` puts in `DetectedGame::confident`.
pub fn is_known(executable: &str) -> bool {
    table_lookup(executable).is_some()
}

fn table_lookup(executable: &str) -> Option<&'static str> {
    let executable = executable.trim();
    if executable.is_empty() {
        return None;
    }
    KNOWN_GAMES
        .iter()
        .find(|(exe, _)| exe.eq_ignore_ascii_case(executable))
        .map(|(_, name)| *name)
}

fn is_non_game(executable: &str) -> bool {
    let executable = executable.trim();
    !executable.is_empty() && NON_GAMES.iter().any(|e| e.eq_ignore_ascii_case(executable))
}

fn exe_stem(executable: &str) -> &str {
    let executable = executable.trim();
    match executable.rsplit_once('.') {
        Some((stem, ext)) if ext.eq_ignore_ascii_case("exe") && !stem.is_empty() => stem,
        _ => executable,
    }
}

/// Separators that may sit between a game name and a suffix, or dangle at either end.
const SEPARATORS: &[char] = &['-', '|', ':', '\u{2013}', '\u{2014}', '\u{00b7}', '\u{2022}'];

/// Turns a window title like `Hunt: Showdown 1896 (64-bit, DX12) - Steam v1.2.3` into
/// `Hunt: Showdown 1896`. Empty when nothing meaningful is left.
fn clean_title(title: &str) -> String {
    let mut s = collapse_whitespace(title);
    loop {
        let before = s.clone();
        s = strip_trailing_group(&s);
        s = strip_trailing_platform(&s);
        s = strip_trailing_version(&s);
        s = strip_separators(&s);
        s = collapse_whitespace(&s);
        if s == before {
            break;
        }
    }
    s
}

fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Removes a trailing `(...)` or `[...]` group such as `(64-bit)` or `[DX12]`.
fn strip_trailing_group(s: &str) -> String {
    let t = s.trim_end();
    for (open, close) in [('(', ')'), ('[', ']')] {
        if t.ends_with(close) {
            if let Some(start) = t.rfind(open) {
                return t[..start].trim_end().to_string();
            }
        }
    }
    t.to_string()
}

/// Removes a trailing launcher/store suffix like ` - Steam` or ` | Epic Games`.
fn strip_trailing_platform(s: &str) -> String {
    const PLATFORMS: &[&str] = &[
        "epic games store",
        "epic games",
        "epic",
        "steam",
        "xbox app",
        "xbox",
        "microsoft store",
        "pc game pass",
        "game pass",
        "ea app",
        "ea",
        "origin",
        "ubisoft connect",
        "uplay",
        "battle.net",
        "gog galaxy",
        "gog",
        "riot client",
    ];
    let t = s.trim_end();
    let lower = t.to_ascii_lowercase();
    for platform in PLATFORMS {
        if lower.ends_with(platform) {
            let head = t[..t.len() - platform.len()].trim_end();
            // Only when it is a separate suffix, not part of the game's own name.
            if head.ends_with(SEPARATORS) {
                return head.to_string();
            }
        }
    }
    t.to_string()
}

/// Removes a trailing version token: `1.2.3`, `v1.0`, `Version 2.1`, `build 4567`.
fn strip_trailing_version(s: &str) -> String {
    let t = s.trim_end();
    let Some(last) = t.rsplit(' ').next() else {
        return t.to_string();
    };
    if !is_version_token(last) {
        return t.to_string();
    }
    let head = t[..t.len() - last.len()].trim_end();
    let lower_head = head.to_ascii_lowercase();
    for word in ["version", "ver", "build", "patch", "v"] {
        if lower_head.ends_with(word) {
            let cut = head.len() - word.len();
            let boundary_ok =
                cut == 0 || head[..cut].ends_with(' ') || head[..cut].ends_with(SEPARATORS);
            if boundary_ok {
                return head[..cut].trim_end().to_string();
            }
        }
    }
    head.to_string()
}

fn is_version_token(tok: &str) -> bool {
    let has_v = tok.starts_with(['v', 'V']);
    let digits = tok.trim_start_matches(['v', 'V']);
    let mut parts = digits.split('.');
    let Some(first) = parts.next() else {
        return false;
    };
    if first.is_empty() || !first.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let mut count = 1;
    for p in parts {
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_alphanumeric()) {
            return false;
        }
        count += 1;
    }
    // Plain integers ("Battlefield 6") are part of a name; "1.2" and "v3" are versions.
    count >= 2 || has_v
}

/// Removes leading and trailing separator characters and whitespace.
fn strip_separators(s: &str) -> String {
    s.trim_matches(|c: char| c.is_whitespace() || SEPARATORS.contains(&c))
        .to_string()
}

/// Programs that are never a game, so a clip saved while they are focused gets no label.
const NON_GAMES: &[&str] = &[
    "cos-nostra-desktop.exe",
    "explorer.exe",
    "searchhost.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "applicationframehost.exe",
    "lockapp.exe",
    "systemsettings.exe",
    "taskmgr.exe",
    "dwm.exe",
    "rundll32.exe",
    "msiexec.exe",
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "opera_gx.exe",
    "vivaldi.exe",
    "arc.exe",
    "discord.exe",
    "discordptb.exe",
    "discordcanary.exe",
    "slack.exe",
    "teams.exe",
    "ms-teams.exe",
    "telegram.exe",
    "whatsapp.exe",
    "zoom.exe",
    "spotify.exe",
    "vlc.exe",
    "mpc-hc64.exe",
    "code.exe",
    "code - insiders.exe",
    "devenv.exe",
    "rider64.exe",
    "idea64.exe",
    "notepad.exe",
    "notepad++.exe",
    "windowsterminal.exe",
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "conhost.exe",
    "obs64.exe",
    "obs32.exe",
    "streamlabs obs.exe",
    "medal.exe",
    "nvidia app.exe",
    "nvidia share.exe",
    "steam.exe",
    "steamwebhelper.exe",
    "epicgameslauncher.exe",
    "battle.net.exe",
    "riotclientservices.exe",
    "riotclientux.exe",
    "eadesktop.exe",
    "eabackgroundservice.exe",
    "origin.exe",
    "upc.exe",
    "ubisoftconnect.exe",
    "galaxyclient.exe",
    "xboxapp.exe",
    "xboxpcapp.exe",
    "gamingservices.exe",
    "wallpaper32.exe",
    "wallpaper64.exe",
    "outlook.exe",
    "winword.exe",
    "excel.exe",
    "powerpnt.exe",
];

/// Executable file name -> display name. Case-insensitive lookup; several rows per game
/// when it ships more than one launcher or renderer binary.
const KNOWN_GAMES: &[(&str, &str)] = &[
    // Shooters
    ("cs2.exe", "Counter-Strike 2"),
    ("csgo.exe", "Counter-Strike: Global Offensive"),
    ("VALORANT-Win64-Shipping.exe", "Valorant"),
    ("r5apex.exe", "Apex Legends"),
    ("r5apex_dx12.exe", "Apex Legends"),
    ("FortniteClient-Win64-Shipping.exe", "Fortnite"),
    ("FortniteClient-Win64-Shipping_EAC.exe", "Fortnite"),
    ("FortniteClient-Win64-Shipping_BE.exe", "Fortnite"),
    ("FortniteClient-Win64-Shipping_EAC_EOS.exe", "Fortnite"),
    ("Overwatch.exe", "Overwatch 2"),
    ("Marvel-Win64-Shipping.exe", "Marvel Rivals"),
    ("Discovery.exe", "The Finals"),
    ("DeltaForceClient-Win64-Shipping.exe", "Delta Force"),
    ("cod.exe", "Call of Duty"),
    ("BF6.exe", "Battlefield 6"),
    ("BF2042.exe", "Battlefield 2042"),
    ("bfv.exe", "Battlefield V"),
    ("bf1.exe", "Battlefield 1"),
    ("RainbowSix.exe", "Rainbow Six Siege"),
    ("RainbowSix_DX11.exe", "Rainbow Six Siege"),
    ("RainbowSix_Vulkan.exe", "Rainbow Six Siege"),
    ("RainbowSix_BE.exe", "Rainbow Six Siege"),
    ("TslGame.exe", "PUBG: Battlegrounds"),
    ("EscapeFromTarkov.exe", "Escape from Tarkov"),
    ("HuntGame.exe", "Hunt: Showdown 1896"),
    ("HaloInfinite.exe", "Halo Infinite"),
    ("MCC-Win64-Shipping.exe", "Halo: The Master Chief Collection"),
    ("Titanfall2.exe", "Titanfall 2"),
    ("destiny2.exe", "Destiny 2"),
    ("Warframe.x64.exe", "Warframe"),
    ("M1-Win64-Shipping.exe", "The First Descendant"),
    ("tf_win64.exe", "Team Fortress 2"),
    ("left4dead2.exe", "Left 4 Dead 2"),
    ("gmod.exe", "Garry's Mod"),
    ("project8.exe", "Deadlock"),
    ("PAYDAY3Client-Win64-Shipping.exe", "PAYDAY 3"),
    ("Back4Blood.exe", "Back 4 Blood"),
    ("GTFO.exe", "GTFO"),
    ("ReadyOrNot-Win64-Shipping.exe", "Ready or Not"),
    ("SquadGame.exe", "Squad"),
    ("HLL-Win64-Shipping.exe", "Hell Let Loose"),
    ("InsurgencyClient-Win64-Shipping.exe", "Insurgency: Sandstorm"),
    ("arma3_x64.exe", "Arma 3"),
    ("ArmaReforgerSteam.exe", "Arma Reforger"),
    ("DayZ_x64.exe", "DayZ"),
    ("DOOMEternalx64vk.exe", "DOOM Eternal"),
    ("DOOMTheDarkAges.exe", "DOOM: The Dark Ages"),
    ("Borderlands3.exe", "Borderlands 3"),
    ("Borderlands4.exe", "Borderlands 4"),
    ("NarakaBladepoint.exe", "Naraka: Bladepoint"),
    // Co-op and party
    ("helldivers2.exe", "Helldivers 2"),
    ("FSD-Win64-Shipping.exe", "Deep Rock Galactic"),
    ("Lethal Company.exe", "Lethal Company"),
    ("Phasmophobia.exe", "Phasmophobia"),
    ("Content Warning.exe", "Content Warning"),
    ("REPO.exe", "R.E.P.O."),
    ("PEAK.exe", "PEAK"),
    ("Schedule I.exe", "Schedule I"),
    ("Chained Together.exe", "Chained Together"),
    ("DEVOUR.exe", "DEVOUR"),
    ("DeadByDaylight-Win64-Shipping.exe", "Dead by Daylight"),
    ("Among Us.exe", "Among Us"),
    ("Overcooked2.exe", "Overcooked! 2"),
    ("PlateUp.exe", "PlateUp!"),
    ("FallGuys_client_game.exe", "Fall Guys"),
    ("Gang Beasts.exe", "Gang Beasts"),
    ("Human.exe", "Human: Fall Flat"),
    ("Golf With Your Friends.exe", "Golf With Your Friends"),
    ("PummelParty.exe", "Pummel Party"),
    ("UltimateChickenHorse.exe", "Ultimate Chicken Horse"),
    ("Tabletop Simulator.exe", "Tabletop Simulator"),
    ("Risk of Rain 2.exe", "Risk of Rain 2"),
    ("vermintide2.exe", "Warhammer: Vermintide 2"),
    ("Darktide.exe", "Warhammer 40,000: Darktide"),
    ("Warhammer 40000 Space Marine 2.exe", "Warhammer 40,000: Space Marine 2"),
    ("SplitFiction.exe", "Split Fiction"),
    ("ItTakesTwo.exe", "It Takes Two"),
    ("portal2.exe", "Portal 2"),
    // Survival and crafting
    ("RustClient.exe", "Rust"),
    ("Palworld-Win64-Shipping.exe", "Palworld"),
    ("valheim.exe", "Valheim"),
    ("enshrouded.exe", "Enshrouded"),
    ("ONCE_HUMAN.exe", "Once Human"),
    ("SonsOfTheForest.exe", "Sons of the Forest"),
    ("TheForest.exe", "The Forest"),
    ("Raft.exe", "Raft"),
    ("7DaysToDie.exe", "7 Days to Die"),
    ("ProjectZomboid64.exe", "Project Zomboid"),
    ("Maine-Win64-Shipping.exe", "Grounded"),
    ("ArkAscended.exe", "ARK: Survival Ascended"),
    ("ShooterGame.exe", "ARK: Survival Evolved"),
    ("ConanSandbox.exe", "Conan Exiles"),
    ("VRising.exe", "V Rising"),
    ("GH.exe", "Green Hell"),
    ("Subnautica.exe", "Subnautica"),
    ("Astro-Win64-Shipping.exe", "Astroneer"),
    ("CoreKeeper.exe", "Core Keeper"),
    ("dontstarve_steam_x64.exe", "Don't Starve Together"),
    ("Terraria.exe", "Terraria"),
    ("Stardew Valley.exe", "Stardew Valley"),
    ("javaw.exe", "Minecraft"),
    ("Minecraft.Windows.exe", "Minecraft"),
    ("RobloxPlayerBeta.exe", "Roblox"),
    ("DungeonCrawler.exe", "Dark and Darker"),
    // Building and management
    ("FactoryGameSteam-Win64-Shipping.exe", "Satisfactory"),
    ("FactoryGameEGS-Win64-Shipping.exe", "Satisfactory"),
    ("FactoryGame-Win64-Shipping.exe", "Satisfactory"),
    ("factorio.exe", "Factorio"),
    ("DSPGAME.exe", "Dyson Sphere Program"),
    ("OxygenNotIncluded.exe", "Oxygen Not Included"),
    ("RimWorldWin64.exe", "RimWorld"),
    ("Dwarf Fortress.exe", "Dwarf Fortress"),
    ("Cities2.exe", "Cities: Skylines II"),
    ("ManorLords-Win64-Shipping.exe", "Manor Lords"),
    ("Frostpunk2-Win64-Shipping.exe", "Frostpunk 2"),
    ("Anno1800.exe", "Anno 1800"),
    // Strategy and cards
    ("dota2.exe", "Dota 2"),
    ("League of Legends.exe", "League of Legends"),
    ("SC2_x64.exe", "StarCraft II"),
    ("Warcraft III.exe", "Warcraft III"),
    ("AoE2DE_s.exe", "Age of Empires II: Definitive Edition"),
    ("RelicCardinal.exe", "Age of Empires IV"),
    ("AoMRT_s.exe", "Age of Mythology: Retold"),
    ("CivilizationVI.exe", "Sid Meier's Civilization VI"),
    ("CivilizationVI_DX12.exe", "Sid Meier's Civilization VI"),
    ("Civ7_Win64_DX12.exe", "Sid Meier's Civilization VII"),
    ("Warhammer3.exe", "Total War: Warhammer III"),
    ("ck3.exe", "Crusader Kings III"),
    ("eu4.exe", "Europa Universalis IV"),
    ("hoi4.exe", "Hearts of Iron IV"),
    ("stellaris.exe", "Stellaris"),
    ("victoria3.exe", "Victoria 3"),
    ("Hearthstone.exe", "Hearthstone"),
    ("Balatro.exe", "Balatro"),
    ("SlayTheSpire.exe", "Slay the Spire"),
    // RPG, action and MMO
    ("eldenring.exe", "Elden Ring"),
    ("nightreign.exe", "Elden Ring Nightreign"),
    ("DarkSoulsIII.exe", "Dark Souls III"),
    ("sekiro.exe", "Sekiro: Shadows Die Twice"),
    ("armoredcore6.exe", "Armored Core VI"),
    ("LOP-Win64-Shipping.exe", "Lies of P"),
    ("bg3.exe", "Baldur's Gate 3"),
    ("bg3_dx11.exe", "Baldur's Gate 3"),
    ("EoCApp.exe", "Divinity: Original Sin 2"),
    ("Cyberpunk2077.exe", "Cyberpunk 2077"),
    ("witcher3.exe", "The Witcher 3: Wild Hunt"),
    ("SandFall-Win64-Shipping.exe", "Clair Obscur: Expedition 33"),
    ("KingdomCome.exe", "Kingdom Come: Deliverance II"),
    ("Starfield.exe", "Starfield"),
    ("SkyrimSE.exe", "The Elder Scrolls V: Skyrim"),
    ("OblivionRemastered-Win64-Shipping.exe", "The Elder Scrolls IV: Oblivion Remastered"),
    ("Fallout4.exe", "Fallout 4"),
    ("Fallout76.exe", "Fallout 76"),
    ("HogwartsLegacy.exe", "Hogwarts Legacy"),
    ("JediSurvivor.exe", "Star Wars Jedi: Survivor"),
    ("Outlaws.exe", "Star Wars Outlaws"),
    ("ACShadows.exe", "Assassin's Creed Shadows"),
    ("ACValhalla.exe", "Assassin's Creed Valhalla"),
    ("FarCry6.exe", "Far Cry 6"),
    ("MonsterHunterWilds.exe", "Monster Hunter Wilds"),
    ("MonsterHunterWorld.exe", "Monster Hunter: World"),
    ("DD2.exe", "Dragon's Dogma 2"),
    ("re4.exe", "Resident Evil 4"),
    ("b1-Win64-Shipping.exe", "Black Myth: Wukong"),
    ("SB-Win64-Shipping.exe", "Stellar Blade"),
    ("GhostOfTsushima.exe", "Ghost of Tsushima"),
    ("GoW.exe", "God of War"),
    ("GoWR.exe", "God of War Ragnarok"),
    ("HorizonForbiddenWest.exe", "Horizon Forbidden West"),
    ("tlou-i.exe", "The Last of Us Part I"),
    ("tlou-ii.exe", "The Last of Us Part II"),
    ("Spider-Man.exe", "Marvel's Spider-Man"),
    ("Spider-Man2.exe", "Marvel's Spider-Man 2"),
    ("ds.exe", "Death Stranding"),
    ("GTA5.exe", "Grand Theft Auto V"),
    ("GTA5_Enhanced.exe", "Grand Theft Auto V"),
    ("RDR2.exe", "Red Dead Redemption 2"),
    ("Hades.exe", "Hades"),
    ("Hades2.exe", "Hades II"),
    ("deadcells.exe", "Dead Cells"),
    ("hollow_knight.exe", "Hollow Knight"),
    ("Hollow Knight Silksong.exe", "Hollow Knight: Silksong"),
    ("Celeste.exe", "Celeste"),
    ("Cuphead.exe", "Cuphead"),
    ("UNDERTALE.exe", "Undertale"),
    ("VampireSurvivors.exe", "Vampire Survivors"),
    ("Brotato.exe", "Brotato"),
    ("EtG.exe", "Enter the Gungeon"),
    ("isaac-ng.exe", "The Binding of Isaac: Rebirth"),
    ("noita.exe", "Noita"),
    ("DaveTheDiver.exe", "Dave the Diver"),
    ("Diablo IV.exe", "Diablo IV"),
    ("Diablo III64.exe", "Diablo III"),
    ("D2R.exe", "Diablo II: Resurrected"),
    ("PathOfExile.exe", "Path of Exile 2"),
    ("PathOfExileSteam.exe", "Path of Exile 2"),
    ("PathOfExile_x64.exe", "Path of Exile"),
    ("PathOfExile_x64Steam.exe", "Path of Exile"),
    ("Last Epoch.exe", "Last Epoch"),
    ("Grim Dawn.exe", "Grim Dawn"),
    ("Wow.exe", "World of Warcraft"),
    ("WowClassic.exe", "World of Warcraft Classic"),
    ("ffxiv_dx11.exe", "Final Fantasy XIV"),
    ("eso64.exe", "The Elder Scrolls Online"),
    ("Gw2-64.exe", "Guild Wars 2"),
    ("NewWorld.exe", "New World: Aeternum"),
    ("LOSTARK.exe", "Lost Ark"),
    ("BlackDesert64.exe", "Black Desert"),
    ("TL.exe", "Throne and Liberty"),
    ("Albion-Online.exe", "Albion Online"),
    ("rs2client.exe", "RuneScape"),
    ("osclient.exe", "Old School RuneScape"),
    ("exefile.exe", "EVE Online"),
    ("StarCitizen.exe", "Star Citizen"),
    ("EliteDangerous64.exe", "Elite Dangerous"),
    ("NMS.exe", "No Man's Sky"),
    ("GenshinImpact.exe", "Genshin Impact"),
    ("StarRail.exe", "Honkai: Star Rail"),
    ("ZenlessZoneZero.exe", "Zenless Zone Zero"),
    ("Sea of Thieves.exe", "Sea of Thieves"),
    ("SoTGame.exe", "Sea of Thieves"),
    ("aces.exe", "War Thunder"),
    ("WorldOfTanks.exe", "World of Tanks"),
    ("WorldOfWarships.exe", "World of Warships"),
    // Sports, racing, fighting and rhythm
    ("RocketLeague.exe", "Rocket League"),
    ("FC25.exe", "EA Sports FC 25"),
    ("FC26.exe", "EA Sports FC 26"),
    ("NBA2K25.exe", "NBA 2K25"),
    ("NBA2K26.exe", "NBA 2K26"),
    ("F1_25.exe", "F1 25"),
    ("iRacingSim64DX11.exe", "iRacing"),
    ("acs.exe", "Assetto Corsa"),
    ("AC2-Win64-Shipping.exe", "Assetto Corsa Competizione"),
    ("ForzaHorizon5.exe", "Forza Horizon 5"),
    ("forza_steamworks_release_final.exe", "Forza Motorsport"),
    ("BeamNG.drive.x64.exe", "BeamNG.drive"),
    ("Trackmania.exe", "Trackmania"),
    ("eurotrucks2.exe", "Euro Truck Simulator 2"),
    ("amtrucks.exe", "American Truck Simulator"),
    ("FarmingSimulator2025Game.exe", "Farming Simulator 25"),
    ("FlightSimulator.exe", "Microsoft Flight Simulator"),
    ("SnowRunner.exe", "SnowRunner"),
    ("StreetFighter6.exe", "Street Fighter 6"),
    ("Polaris-Win64-Shipping.exe", "Tekken 8"),
    ("MK12.exe", "Mortal Kombat 1"),
    ("GGST-Win64-Shipping.exe", "Guilty Gear Strive"),
    ("Beat Saber.exe", "Beat Saber"),
    ("osu!.exe", "osu!"),
    ("GeometryDash.exe", "Geometry Dash"),
    ("BloonsTD6.exe", "Bloons TD 6"),
    ("KSP_x64.exe", "Kerbal Space Program"),
    ("TS4_x64.exe", "The Sims 4"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_hits_are_case_insensitive() {
        assert_eq!(name_for("cs2.exe", "").as_deref(), Some("Counter-Strike 2"));
        assert_eq!(name_for("CS2.EXE", "").as_deref(), Some("Counter-Strike 2"));
        assert_eq!(name_for("R5APEX.exe", "anything").as_deref(), Some("Apex Legends"));
        assert_eq!(name_for("valorant-win64-shipping.exe", "").as_deref(), Some("Valorant"));
        assert_eq!(name_for("JAVAW.EXE", "Minecraft 1.21").as_deref(), Some("Minecraft"));
        assert_eq!(name_for("Minecraft.Windows.exe", "").as_deref(), Some("Minecraft"));
        assert_eq!(name_for("robloxplayerbeta.exe", "").as_deref(), Some("Roblox"));
        assert_eq!(name_for("HELLDIVERS2.exe", "").as_deref(), Some("Helldivers 2"));
        assert_eq!(name_for("Lethal Company.exe", "").as_deref(), Some("Lethal Company"));
        assert_eq!(name_for("cod.exe", "Call of Duty").as_deref(), Some("Call of Duty"));
    }

    #[test]
    fn table_has_no_duplicate_executables() {
        let mut seen: Vec<String> = Vec::new();
        for (exe, _) in KNOWN_GAMES {
            let lower = exe.to_ascii_lowercase();
            assert!(!seen.contains(&lower), "duplicate table entry {exe}");
            assert!(!NON_GAMES.iter().any(|n| n.eq_ignore_ascii_case(exe)), "{exe} in both lists");
            seen.push(lower);
        }
        assert!(KNOWN_GAMES.len() >= 60);
    }

    #[test]
    fn unknown_exe_falls_back_to_cleaned_title() {
        assert_eq!(clean_title("Hunt: Showdown 1896 (64-bit, DX12) - Steam"), "Hunt: Showdown 1896");
        assert_eq!(clean_title("Some Game (DX12)"), "Some Game");
        assert_eq!(clean_title("Some Game [Vulkan] v1.2.3"), "Some Game");
        assert_eq!(clean_title("Some Game 1.0.4"), "Some Game");
        assert_eq!(clean_title("Some Game Version 2.1"), "Some Game");
        assert_eq!(clean_title("Some   Game   -  "), "Some Game");
        assert_eq!(clean_title("Some Game - Epic Games"), "Some Game");
        assert_eq!(clean_title("Battlefield 6"), "Battlefield 6");
        assert_eq!(clean_title("Left 4 Dead 2"), "Left 4 Dead 2");
        assert_eq!(clean_title("Steam Marines"), "Steam Marines");
        assert_eq!(clean_title("  (64-bit) - "), "");
        assert_eq!(
            name_for("mystery.exe", "Mystery Game (64-bit) - Steam").as_deref(),
            Some("Mystery Game")
        );
        assert_eq!(name_for("mystery.exe", "   "), None);
        assert_eq!(name_for("", "Windowed Game (DX11)").as_deref(), Some("Windowed Game"));
    }

    #[test]
    fn non_games_are_rejected_even_with_a_title() {
        for exe in [
            "explorer.exe",
            "EXPLORER.EXE",
            "chrome.exe",
            "msedge.exe",
            "Discord.exe",
            "Code.exe",
            "obs64.exe",
            "steam.exe",
            "cos-nostra-desktop.exe",
        ] {
            assert_eq!(name_for(exe, "Counter-Strike 2 - Steam"), None, "{exe}");
        }
        // ffplay stays hookable so capture tests can use it.
        assert_eq!(name_for("ffplay.exe", "clip.mp4").as_deref(), Some("clip.mp4"));
    }

    #[test]
    fn exe_stem_strips_extension() {
        assert_eq!(exe_stem("game.exe"), "game");
        assert_eq!(exe_stem("Game.EXE"), "Game");
        assert_eq!(exe_stem("BeamNG.drive.x64.exe"), "BeamNG.drive.x64");
        assert_eq!(exe_stem("noext"), "noext");
    }

    #[test]
    #[ignore = "needs a focused window; run with --ignored --nocapture"]
    fn prints_foreground_detection() {
        println!("foreground_window() = {:?}", crate::win::foreground_window());
        println!("detect_foreground() = {:?}", detect_foreground());
    }
}
