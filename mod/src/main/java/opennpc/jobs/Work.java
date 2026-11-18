package opennpc.jobs;

import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.item.ItemEntity;
import opennpc.entity.CompanionEntity;

/**
 * A job the companion carries out by herself, one tick at a time on the server: chopping, mining, crafting, fighting,
 * handing things over. It reports back when it is done or gives up, in plain words, so the AI can hear how it went.
 */
public abstract class Work {
	public enum Status { RUNNING, DONE, FAILED }

	protected final CompanionEntity c;
	/** Asked for by the owner (a job the AI started on its own doesn't push one of his aside). */
	public final boolean byPlayer;
	protected int ticks = 0;
	/** How it went, in plain words, once it's over. */
	public String result = "";
	public String reason = "";

	protected Work(CompanionEntity c, boolean byPlayer) {
		this.c = c;
		this.byPlayer = byPlayer;
	}

	/** What it is, for "doing now" and the job events: "chopping wood". */
	public abstract String label();

	/** One tick of work. */
	protected abstract Status step(ServerLevel level);

	public final Status tick(ServerLevel level) {
		ticks++;
		return step(level);
	}

	/** Stopped from outside (told to follow, stay, or something else). */
	public void cancel(ServerLevel level) {}

	/** Items lying around that this job wants her to pick up (her own drops by default). */
	public boolean wants(ItemEntity item) {
		return c.brokeNear(item.position(), 4.0);
	}

	/** How far along it is, for "doing now". */
	public String progress() { return ""; }

	protected Status done(String result) {
		this.result = result;
		return Status.DONE;
	}

	protected Status fail(String reason) {
		this.reason = reason;
		return Status.FAILED;
	}

	/** The event the job sends when it ends. */
	public Map<String, String> endData() {
		Map<String, String> d = new LinkedHashMap<>();
		d.put("task", label());
		if (!result.isEmpty()) d.put("result", result);
		if (!reason.isEmpty()) d.put("reason", reason);
		return d;
	}
}
