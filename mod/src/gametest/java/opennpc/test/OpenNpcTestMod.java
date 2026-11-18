package opennpc.test;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import opennpc.OpenNpc;

/** The tests make their own companions and stand-in AIs; the mod's own companion stays out of their way. */
public class OpenNpcTestMod implements ModInitializer {
	static final List<Runnable> cleanup = new CopyOnWriteArrayList<>();

	@Override
	public void onInitialize() {
		if (System.getProperty("fabric-api.gametest") != null && System.getProperty("fabric.client.gametest") == null) OpenNpc.autoCompanion = false;
		OpenNpc.LOG.info("[test] server game tests: {}, client game tests: {}", System.getProperty("fabric-api.gametest"), System.getProperty("fabric.client.gametest"));
		ServerLifecycleEvents.SERVER_STOPPING.register(s -> { for (Runnable r : cleanup) { try { r.run(); } catch (Exception ignored) {} } cleanup.clear(); });
	}
}
