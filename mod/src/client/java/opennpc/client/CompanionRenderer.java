package opennpc.client;

import com.mojang.blaze3d.vertex.PoseStack;
import net.minecraft.client.model.geom.ModelLayers;
import net.minecraft.client.model.player.PlayerModel;
import net.minecraft.client.renderer.entity.ArmorModelSet;
import net.minecraft.client.renderer.entity.EntityRendererProvider;
import net.minecraft.client.renderer.entity.HumanoidMobRenderer;
import net.minecraft.client.renderer.entity.layers.HumanoidArmorLayer;
import net.minecraft.client.renderer.entity.state.AvatarRenderState;
import net.minecraft.core.ClientAsset;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.PlayerModelType;
import net.minecraft.world.entity.player.PlayerSkin;
import opennpc.OpenNpc;
import opennpc.entity.CompanionEntity;

/** She looks like a player with slim arms, in her own skin. */
public class CompanionRenderer extends HumanoidMobRenderer<CompanionEntity, AvatarRenderState, PlayerModel> {
	static final Identifier TEXTURE = Identifier.fromNamespaceAndPath(OpenNpc.ID, "textures/entity/companion.png");
	static final PlayerSkin SKIN = PlayerSkin.insecure(
		new ClientAsset.ResourceTexture(Identifier.fromNamespaceAndPath(OpenNpc.ID, "entity/companion"), TEXTURE), null, null, PlayerModelType.SLIM);

	public CompanionRenderer(EntityRendererProvider.Context ctx) {
		super(ctx, new PlayerModel(ctx.bakeLayer(ModelLayers.PLAYER_SLIM), true), 0.5F);
		this.addLayer(new HumanoidArmorLayer<>(this,
			ArmorModelSet.bake(ModelLayers.PLAYER_SLIM_ARMOR, ctx.getModelSet(), part -> new PlayerModel(part, true)),
			ctx.getEquipmentRenderer()));
	}

	@Override
	public AvatarRenderState createRenderState() {
		return new AvatarRenderState();
	}

	@Override
	public void extractRenderState(CompanionEntity entity, AvatarRenderState state, float partialTicks) {
		super.extractRenderState(entity, state, partialTicks);
		state.skin = SKIN;
		state.showHat = true;
		state.showJacket = true;
		state.showLeftPants = true;
		state.showRightPants = true;
		state.showLeftSleeve = true;
		state.showRightSleeve = true;
		state.showCape = false;
		state.id = entity.getId();
	}

	@Override
	public Identifier getTextureLocation(AvatarRenderState state) {
		return TEXTURE;
	}

	@Override
	protected void scale(AvatarRenderState state, PoseStack poseStack) {
		poseStack.scale(0.9375F, 0.9375F, 0.9375F);
	}
}
