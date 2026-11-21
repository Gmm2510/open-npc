package opennpc.jobs;

import com.google.common.collect.AbstractIterator;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.tags.TagKey;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.level.block.Block;

/**
 * The few things Minecraft names or shapes differently from one version to the next, written so the same code builds for
 * every version in versions.json: things are found by their game id ("minecraft:creeper"), which stays the same, instead of
 * by a Java name that moves.
 */
public final class Versions {
	private Versions() {}

	/** An entity type by its id ("creeper"). */
	public static EntityType<?> entityType(String id) {
		return BuiltInRegistries.ENTITY_TYPE.getOptional(Identifier.withDefaultNamespace(id)).orElseThrow();
	}

	/** A block tag by its id ("coal_ores"). */
	public static TagKey<Block> blockTag(String id) {
		return TagKey.create(Registries.BLOCK, Identifier.withDefaultNamespace(id));
	}

	/** A sound from SoundEvents, whichever of the two ways the game's version lists it. */
	public static SoundEvent sound(SoundEvent sound) {
		return sound;
	}

	public static SoundEvent sound(Holder<SoundEvent> sound) {
		return sound.value();
	}

	/**
	 * The blocks around a spot, nearest first (by steps along the axes), out to reachX, reachY and reachZ: the same blocks in
	 * the same order as the game's own BlockPos.withinManhattan(origin, reachX, reachY, reachZ) up to 26.2. The spots it hands
	 * out are one changing BlockPos, so keep one with immutable().
	 */
	public static Iterable<BlockPos> withinManhattan(BlockPos origin, int reachX, int reachY, int reachZ) {
		int maxDepth = reachX + reachY + reachZ;
		int originX = origin.getX();
		int originY = origin.getY();
		int originZ = origin.getZ();
		return () -> new AbstractIterator<BlockPos>() {
			private final BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
			private int currentDepth;
			private int maxX;
			private int maxY;
			private int x;
			private int y;
			private boolean zMirror;

			@Override
			protected BlockPos computeNext() {
				if (zMirror) {
					zMirror = false;
					cursor.setZ(originZ - (cursor.getZ() - originZ));
					return cursor;
				}
				BlockPos found = null;
				while (found == null) {
					if (y > maxY) {
						x++;
						if (x > maxX) {
							currentDepth++;
							if (currentDepth > maxDepth) return endOfData();
							maxX = Math.min(reachX, currentDepth);
							x = -maxX;
						}
						maxY = Math.min(reachY, currentDepth - Math.abs(x));
						y = -maxY;
					}
					int z = currentDepth - Math.abs(x) - Math.abs(y);
					if (z <= reachZ) {
						zMirror = z != 0;
						found = cursor.set(originX + x, originY + y, originZ + z);
					}
					y++;
				}
				return found;
			}
		};
	}
}
