# Minecraft 26.3: the update build failed

Loader 0.20.1, Fabric API 0.166.2+26.3. Make `./gradlew build` and `./gradlew runProductionClientGameTest` pass for
this version (pass `-Pminecraft_version=26.3 -Ploader_version=0.20.1 -Pfabric_api_version=0.166.2+26.3`) without breaking the
versions already in versions.json, then delete this file and open a pull request to main.

## The end of the build log

```
Starting a Gradle Daemon (subsequent builds will be faster)

> Configure project :
Fabric Loom: 1.19.4

> Task :compileJava FAILED
/home/runner/work/open-npc/open-npc/mod/src/main/java/opennpc/entity/CompanionEntity.java:397: error: no suitable method found for swing(InteractionHand)
		if (emoteTicks == 22 || emoteTicks == 14) this.swing(InteractionHand.MAIN_HAND);
		                                              ^
    method LivingEntity.swing(InteractionHand,SwingAnimation,boolean) is not applicable
      (actual and formal argument lists differ in length)
    method Mob.swing(InteractionHand,SwingAnimation) is not applicable
      (actual and formal argument lists differ in length)
Note: /home/runner/work/open-npc/open-npc/mod/src/main/java/opennpc/entity/SmoothMoveControl.java uses unchecked or unsafe operations.
Note: Recompile with -Xlint:unchecked for details.
1 error
gradle/actions: Writing build results to /home/runner/work/_temp/.gradle-actions/build-results/try-1795114782170.json

[Incubating] Problems report is available at: file:///home/runner/work/open-npc/open-npc/mod/build/reports/problems/problems-report.html

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':compileJava' (registered by plugin class 'org.gradle.api.plugins.JavaBasePlugin').
> Compilation failed; see the compiler output below.
  /home/runner/work/open-npc/open-npc/mod/src/main/java/opennpc/entity/CompanionEntity.java:397: error: no suitable method found for swing(InteractionHand)
  		if (emoteTicks == 22 || emoteTicks == 14) this.swing(InteractionHand.MAIN_HAND);
  		                                              ^
      method LivingEntity.swing(InteractionHand,SwingAnimation,boolean) is not applicable
        (actual and formal argument lists differ in length)
      method Mob.swing(InteractionHand,SwingAnimation) is not applicable
        (actual and formal argument lists differ in length)
  Note: /home/runner/work/open-npc/open-npc/mod/src/main/java/opennpc/entity/SmoothMoveControl.java uses unchecked or unsafe operations.
  Note: Recompile with -Xlint:unchecked for details.
  1 error

* Try:
> Check your code and dependencies to fix the compilation error(s)
> Run with --scan to get full insights from a Build Scan (powered by Develocity).

BUILD FAILED in 9s
1 actionable task: 1 executed
```
