package opennpc;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Settings, read from config/opennpc.json in the game folder (made with these defaults the first time).
 */
public final class NpcConfig {
	/** The companion's name in the game. */
	public String name = "Ana";
	/** true: when the app at the AI address names her on its wait door (the companion picked in a voice app), she takes that name
	 * and changes it when the app does; "name" is used otherwise. Renaming her with /npc name turns this off. */
	public boolean useAppName = true;
	/** Who she belongs to (a Minecraft name). Empty: the host of a single-player world, or the first player who joins a server. */
	public String owner = "";
	/** "auto": her words go in the game chat unless the AI address has a wait door (a voice app speaks for her). "yes" or "no" to choose. */
	public String speakInChat = "auto";
	/** How far behind the owner she keeps, in blocks (2 to 12). */
	public double followGap = 4;
	/** Minutes with nothing to do before she asks the AI what to do on her own (0: never). */
	public int freeTimeMinutes = 4;
	public Ai ai = new Ai();

	public static final class Ai {
		/** Any address that answers OpenAI-style chat completions with tools, ending in /v1. */
		public String url = "http://127.0.0.1:41751/v1";
		/** The API key for that address (or the NPC_AI_KEY environment variable). Empty for a local model or app. */
		public String key = "";
		/** The model name. Empty: the first one the address lists. */
		public String model = "";
	}

	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	public static NpcConfig load(Path file) {
		NpcConfig c = null;
		try {
			if (Files.exists(file)) c = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8), NpcConfig.class);
		} catch (Exception e) {
			OpenNpc.LOG.warn("Open NPC: {} could not be read ({}); using the defaults", file, e.getMessage());
		}
		if (c == null) {
			c = new NpcConfig();
			try {
				Files.createDirectories(file.getParent());
				Files.writeString(file, GSON.toJson(c), StandardCharsets.UTF_8);
			} catch (IOException e) {
				OpenNpc.LOG.warn("Open NPC: could not write {}: {}", file, e.getMessage());
			}
		}
		if (c.ai == null) c.ai = new Ai();
		c.name = cleanName(c.name);
		c.followGap = Math.max(2, Math.min(12, c.followGap));
		c.freeTimeMinutes = Math.max(0, c.freeTimeMinutes);
		return c;
	}

	public void save(Path file) {
		try {
			Files.createDirectories(file.getParent());
			Files.writeString(file, GSON.toJson(this), StandardCharsets.UTF_8);
		} catch (IOException e) {
			OpenNpc.LOG.warn("Open NPC: could not write {}: {}", file, e.getMessage());
		}
	}

	public String key() {
		if (ai.key != null && !ai.key.isBlank()) return ai.key.trim();
		String env = System.getenv("NPC_AI_KEY");
		return env == null ? "" : env.trim();
	}

	/** 1 to 16 letters (any language), digits, spaces or _ ; anything else becomes "Ana". */
	public static String cleanName(String n) {
		String s = cleanOrEmpty(n);
		return s.isEmpty() ? "Ana" : s;
	}

	/** The same rules, but nothing usable stays empty. */
	public static String cleanOrEmpty(String n) {
		String s = n == null ? "" : n.replaceAll("[^\\p{L}\\p{N}_ ]", "").replaceAll("\\s+", " ").trim();
		if (s.length() > 16) s = s.substring(0, 16).trim();
		return s;
	}

	/** The name she goes by: the app's, when it gives one and that's allowed, else her own setting. */
	public String shownName(String appName) {
		return useAppName && appName != null && !appName.isBlank() ? appName : name;
	}
}
