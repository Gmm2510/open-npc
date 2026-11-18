package opennpc.client;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.rendering.v1.EntityRendererRegistry;
import opennpc.OpenNpc;

public class OpenNpcClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		EntityRendererRegistry.register(OpenNpc.COMPANION, CompanionRenderer::new);
	}
}
