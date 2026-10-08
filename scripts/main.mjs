import { CombatCarousel } from './CombatCarousel.mjs';
import { registerSettings, forceActionReselect } from './settings.mjs';

export const MODULE_ID = 'fantastic-depths-combat-carousel';

function _isDebug() {
  try { return game.settings.get(MODULE_ID, 'debugMode'); } catch(e) { return false; }
}
function _log(...args) { if (_isDebug()) console.log('%cFDCC:main |', 'color:#0f9; font-weight:bold', ...args); }

Hooks.once('init', () => {
  registerSettings();
});

Hooks.on('closeSettingsConfig', () => {
  if (ui.combatCarousel?.rendered) ui.combatCarousel._updateRoundIndicator();
});

Hooks.once('ready', () => {
  // Patch FaDe's Combatant subclass roundReset to preserve player-chosen actions.
  // FaDe defines roundReset on its own subclass (class ti extends Combatant),
  // accessible via CONFIG.Combatant.documentClass.prototype at ready time.
  // It resets declaredAction to weapon default ("attack"/"fire") on every round change.
  const FadeCombatantProto = CONFIG.Combatant.documentClass.prototype;
  // Patch FaDe's isSlowed getter to guard against undefined actor.system.combat.phase.
  // FaDe's fadeCombatant.ts:70 crashes when combat or phase is undefined (e.g. NPCs without full actor data).
  const isSlowedDescriptor = Object.getOwnPropertyDescriptor(FadeCombatantProto, 'isSlowed');
  if (isSlowedDescriptor?.get) {
    const origIsSlowed = isSlowedDescriptor.get;
    Object.defineProperty(FadeCombatantProto, 'isSlowed', {
      get() {
        try { return origIsSlowed.call(this); } catch(e) { return false; }
      },
      configurable: true
    });
  }
  if (typeof FadeCombatantProto.roundReset === 'function') {
    const origRoundReset = FadeCombatantProto.roundReset;
    FadeCombatantProto.roundReset = async function(deleteAction = false) {
      const carousel = ui.combatCarousel;
      let savedAction = null;
      let choseNothing = false;
      let nextRound = 'reset';
      try { nextRound = game.settings.get(game.system.id, 'nextRound') ?? 'reset'; } catch(e) {}
      // Override FaDe defaults only when the world setting requires re-selection AND
      // we are in a next-round change (_roundChanging). Combat start always uses FaDe defaults.
      const overrideForReselect = carousel && !deleteAction && carousel._roundChanging && forceActionReselect();
      _log(`roundReset | ${this.name} | deleteAction=${deleteAction} | nextRound=${nextRound} | override=${!!overrideForReselect}`);
      if (overrideForReselect) {
        savedAction = this.actor?.system?.combat?.declaredAction ?? null;
        choseNothing = this.getFlag('fantastic-depths-combat-carousel', 'choseNothing') ?? false;
        if (nextRound === 'hold') {
          // hold: call origRoundReset normally then restore the saved action
          await origRoundReset.call(this, false);
          if (choseNothing) {
              await Promise.all([
              this.setFlag('fantastic-depths-combat-carousel', 'choseNothing', true),
              this.actor?.update({ 'system.combat.declaredAction': null })
            ]);
          } else if (savedAction && savedAction !== 'nothing') {
            await this.actor?.update({ 'system.combat.declaredAction': savedAction });
          }
        } else {
          // reset/reroll: BYPASS FaDe's roundReset — force re-selection
          // 'nothing' displays as "Select..." (yellow); null gets auto-converted to "attack"
          if (choseNothing) await this.unsetFlag('fantastic-depths-combat-carousel', 'choseNothing');
          await this.actor?.update({ 'system.combat.declaredAction': 'nothing' });
        }
      } else {
        // Combat start, exit, or carousel inactive: use FaDe defaults (attack/fire)
        await origRoundReset.call(this, deleteAction);
      }
    };
  } else {
  }

  // Patch FaDe's Combat.nextRound to block automatic rollInitiative in 'reroll' mode
  // when the carousel is active. The carousel will trigger the roll via _autoRollIfReady()
  // only after all players have chosen their actions.
  const FadeCombatProto = CONFIG.Combat.documentClass.prototype;
  if (typeof FadeCombatProto.nextRound === 'function') {
    const origNextRound = FadeCombatProto.nextRound;
    FadeCombatProto.nextRound = async function() {
      const carousel = ui.combatCarousel;
      const isReroll = this.nextRoundMode === 'reroll';
      const isReset = this.nextRoundMode === 'reset';
      const isHold = this.nextRoundMode === 'hold';
      const requireReselect = forceActionReselect();
      if (carousel && (isReroll || isReset || isHold)) {
        _log(`nextRound PATCH | isReroll=${isReroll} isReset=${isReset} isHold=${isHold} | forceActionReselect=${requireReselect}`);
        // Clear any pending tie rerolls from the previous round so deferred _fixTurnToHighestInit
        // callbacks (still in setTimeout queues) abort immediately and don't fire combat.update
        carousel._pendingTieRerolls?.clear();
        if (requireReselect) {
          // Mark all combatants as "pending re-selection" so the carousel shows yellow
          carousel._resetPendingIds = new Set(Array.from(this.combatants).map(c => c.id));
          // Block updateActor hook from removing combatants during FaDe's roundReset calls
          carousel._roundChanging = true;
          // IMMEDIATE REFRESH: Show "Seleziona..." (yellow borders) right away before actor updates propagate
          carousel.refreshCards();
        }
      }
      let result;
      // Note: roundReset patch calls origRoundReset(true) for reset/reroll → FaDe writes null directly
      if (carousel && isReroll) {
        // Block FaDe's automatic rollInitiative — carousel triggers it via _autoRollIfReady()
        const origRollInitiative = this.rollInitiative.bind(this);
        this.rollInitiative = async () => {
        };
        result = await origNextRound.call(this);
        this.rollInitiative = origRollInitiative;
      } else {
        result = await origNextRound.call(this);
      }
      if (carousel && (isReroll || isReset || isHold)) {
        // Keep _roundChanging until reselection settles (only when forcing re-select).
        // Do a deferred refresh so the UI catches FaDe defaults or yellow pending cards.
        setTimeout(() => {
          carousel._roundChanging = false;
          carousel.refreshCards();
          // With FaDe defaults, attack/fire may be a no-op update — nudge auto-roll for reroll mode
          if (!requireReselect && isReroll) carousel._autoRollIfReady();
          // In individual modes, always reset turn to highest initiative after round change
          // This is needed for hold mode where initiatives don't change but turn must reset
          if ((carousel.initiativeMode === 'individualChecklist' || carousel.initiativeMode === 'simpleIndividual') && game.user.isGM) {
            setTimeout(() => carousel._fixTurnToHighestInit(), 100);
          }
        }, 300);
      }
      return result;
    };
  } else {
  }
  // Socket handler: GM executes combatant initiative updates on behalf of players
  const socketName = `module.${MODULE_ID}`;
  game.socket.on(socketName, async (msg) => {
    _log(`SOCKET ← ${msg.action}`, msg);
    // removePendingId is handled by non-GM clients only
    // GM manages _resetPendingIds locally (nextRound patch + _onActionChange + updateActor hook)
    if (msg.action === 'removePendingId') {
      if (!game.user.isGM) {
        const carousel = ui.combatCarousel;
        const combat = game.combats.get(msg.combatId);
        if (carousel && combat && ui.combatCarousel?.combat === combat) {
          if (msg.round != null && msg.round !== combat.round) return;
          if (carousel._resetPendingIds?.has(msg.combatantId)) {
            carousel._resetPendingIds.delete(msg.combatantId);
            carousel.refreshCards();
          }
        }
      }
      return;
    }
    // clearAllPendingIds: GM auto-rolled (all actions already chosen from prev round), tell clients to exit yellow state
    if (msg.action === 'clearAllPendingIds') {
      if (!game.user.isGM) {
        const carousel = ui.combatCarousel;
        const combat = game.combats.get(msg.combatId);
        if (carousel && combat && carousel.combat === combat) {
          carousel._resetPendingIds?.clear();
          carousel.refreshCards();
        }
      }
      return;
    }
    // syncTieRerolls / clearTieRerolls: handled by non-GM clients to show orange tie indicator
    if (msg.action === 'syncTieRerolls') {
      if (!game.user.isGM) {
        const carousel = ui.combatCarousel;
        const combat = game.combats.get(msg.combatId);
        if (carousel && combat && carousel.combat === combat) {
          if (msg.round != null && msg.round !== combat.round) return;
          carousel._pendingTieRerolls = new Set(msg.ids);
          // Refresh immediately to show orange snail indicator — initiative value is not relevant here
          // (the accurate initiative-based refresh happens in updateCombatant hook when DB is updated)
          carousel.refreshCards();
        }
      }
      return;
    }
    if (msg.action === 'clearTieRerolls') {
      if (!game.user.isGM) {
        const carousel = ui.combatCarousel;
        const combat = game.combats.get(msg.combatId);
        if (carousel && combat && carousel.combat === combat) {
          if (msg.round != null && msg.round !== combat.round) {
            return;
          }
          carousel._pendingTieRerolls.clear();
          // CRITICAL FIX: Force complete state synchronization after ties are resolved
          // This prevents clients from getting stuck with "round not started" state
          setTimeout(() => {
            if (carousel && combat && carousel.combat === combat) {
              // Force a complete refresh to ensure combat state is properly synchronized
              carousel.refreshCards();
              // Additional safety check: if combat is started but carousel shows wrong state, force update
              if (combat.started && carousel._hasPlayerUnselectedActions?.() === false) {
                setTimeout(() => carousel.refreshCards(), 100);
              }
            }
          }, 50);
        }
      }
      return;
    }
    // forceCombatSync: GM forces complete combat state synchronization to all clients after ties are resolved
    if (msg.action === 'forceCombatSync') {
      if (!game.user.isGM) {
        const carousel = ui.combatCarousel;
        const combat = game.combats.get(msg.combatId);
        if (carousel && combat && carousel.combat === combat) {
          if (msg.round != null && msg.round !== combat.round) {
            return;
          }
          // CRITICAL FIX: Force complete state synchronization to prevent clients from getting stuck
          // This ensures all clients have the exact same combat state as GM after multiple tie scenarios
          setTimeout(() => {
            if (carousel && combat && carousel.combat === combat) {
              // Force multiple refreshes to ensure state is fully synchronized
              carousel.refreshCards();
              setTimeout(() => {
                if (carousel && combat && carousel.combat === combat) {
                  carousel.refreshCards();
                  // Final safety check: ensure combat state consistency
                  if (combat.started && carousel._hasPlayerUnselectedActions?.() === false) {
                    setTimeout(() => carousel.refreshCards(), 50);
                  }
                }
              }, 100);
            }
          }, 50);
        }
      }
      return;
    }
    // markTieRerolled: GM broadcasts to clients when a specific combatant completes their tie reroll
    if (msg.action === 'markTieRerolled') {
      if (!game.user.isGM) {
        const carousel = ui.combatCarousel;
        const combat = game.combats.get(msg.combatId);
        if (carousel && combat && carousel.combat === combat) {
          if (msg.round != null && msg.round !== combat.round) return;
          if (carousel._pendingTieRerolls?.has(msg.combatantId)) {
            carousel._pendingTieRerolls.delete(msg.combatantId);
            carousel.refreshCards();
          }
        }
      }
      return;
    }
    // actionChanged: sync action selection to ALL clients (bypasses Foundry permission restrictions for NPCs)
    // This allows players to see NPC actions selected by GM even without Observer permission
    if (msg.action === 'actionChanged') {
      const carousel = ui.combatCarousel;
      const combat = game.combats.get(msg.combatId);
      if (carousel && combat && carousel.combat === combat) {
        // NOTE: We accept actionChanged for ANY round to avoid race conditions
        // where socket arrives before combat.round update on client
        // Store in shadow state (non-GM clients need this since they don't receive updateActor for NPCs)
        if (msg.newAction !== 'nothing') {
          carousel._npcActions.set(msg.combatantId, msg.newAction);
        } else {
          carousel._npcActions.delete(msg.combatantId);
        }
        // Also remove from pending if present
        if (carousel._resetPendingIds?.has(msg.combatantId)) {
          carousel._resetPendingIds.delete(msg.combatantId);
        }
        carousel.refreshCards();
      }
      return;
    }
    if (!game.user.isGM) return;
    const combat = game.combats.get(msg.combatId);
    if (!combat) return;
    if (msg.action === 'setGroupInitiative') {
      await Promise.all(msg.ids.map(id => combat.combatants.get(id)?.update({ initiative: msg.value })));
    } else if (msg.action === 'setSortedTurnIdx') {
      await combat.setFlag('fantastic-depths-combat-carousel', 'sortedTurnIdx', msg.value);
      if (ui.combatCarousel?.combat === combat) {
        ui.combatCarousel._sortedTurnIdx = msg.value;
        ui.combatCarousel.refreshCards();
      }
    }
  });

  // Prevent PlayerCombatForm from auto-opening for players
  if (!game.user.isGM) {
    // The FaDe system opens PlayerCombatForm via socket "showPlayerCombat"
    // which does: foundry.applications.instances.get("party-combat-form") ?? new Ve).render(true)
    // We register a dummy app instance with that ID so the system finds it and calls render() on it (no-op)
    const FADE_COMBAT_FORM_ID = 'party-combat-form';

    // Close existing instance if any
    const existing = foundry.applications.instances.get(FADE_COMBAT_FORM_ID);
    if (existing) {
      try { existing.close(); } catch (e) {}
    }

    // Create a dummy object that mimics an ApplicationV2 just enough
    const dummyApp = {
      id: FADE_COMBAT_FORM_ID,
      render() { return this; },
      close() { return this; },
      rendered: false,
      options: { id: FADE_COMBAT_FORM_ID }
    };

    // Register it in foundry's application instances map
    foundry.applications.instances.set(FADE_COMBAT_FORM_ID, dummyApp);

    // Also trap game.fade.combatForm
    if (game.fade) {
      Object.defineProperty(game.fade, 'combatForm', {
        get() { return dummyApp; },
        set(v) { /* ignore */ },
        configurable: true
      });
    }

  }

  const currentCombat = game.combat;
  if (currentCombat) {
    new CombatCarousel(currentCombat).render(true);
  }
});

Hooks.on('createCombat', (combat) => {
  if (game.combat === combat) {
    new CombatCarousel(combat).render(true);
  }
});

Hooks.on('updateCombat', (combat, updates) => {
  if (updates.active || updates.scene === null) {
    new CombatCarousel(combat).render(true);
  }
  if (updates.scene && combat.scene !== game.scenes?.viewed && ui.combatCarousel?.combat === combat) {
    ui.combatCarousel.close();
  }
});

Hooks.on('deleteCombat', (combat) => {
  if (ui.combatCarousel?.combat === combat) {
    ui.combatCarousel.close();
  }
});

Hooks.on('createCombatant', async (combatant) => {
  if (ui.combatCarousel) {
    const carousel = ui.combatCarousel;
    const combat = carousel.combat;
    
    // Special handling for group modes when combatant joins after round 0
    if (combat?.started && combat.round > 0 && (carousel.isGroupMode || carousel.isAdvancedGroupMode)) {
      console.log(`FDCC:main | createCombatant | ${combatant.name} | round=${combat.round} | mode=${carousel.initiativeMode}`);
      // Capture the currently active combatant BEFORE the new combatant is added and reorders combat.turns.
      // In group mode, adding a combatant re-sorts combat.turns by initiative, so the numeric combat.turn
      // index may end up pointing to a different combatant. We must restore the active turn afterwards.
      const activeBefore = combat.turns[combat.turn];
      const activeBeforeId = activeBefore?.id;
      const activeBeforeName = activeBefore?.name;
      const activeBeforeTurn = combat.turn;
      // Remember the active combatant across the re-sort so intermediate refreshes don't flash
      // the active card onto the newly joined combatant.
      carousel._midRoundJoinActiveId = activeBeforeId;
      // Lock the canvas selection onto the active token immediately to prevent the new token
      // from flashing onto the scene when the GM adds it.
      carousel._selectActiveToken();
      carousel._guardTokenSelection(2000);

      // Assign current group initiative to new combatant and wait for it to apply,
      // so the subsequent turn restoration sees the final re-sorted combat.turns.
      const groupInitiative = carousel._getGroupInitiative(combatant);
      if (groupInitiative !== null) {
        await combatant.update({ initiative: groupInitiative });
      }
      
      // Mark existing combatants with "nothing" action as waiting for next round
      // This prevents their "nothing" actions from blocking the carousel
      for (const existingCombatant of combat.combatants) {
        if (existingCombatant.id !== combatant.id && existingCombatant.actor?.system?.combat?.declaredAction === 'nothing') {
          await existingCombatant.setFlag('fantastic-depths-combat-carousel', 'waitingForRound', true);
        }
      }
      
      // Mark new combatant as waiting for next round FIRST (before any carousel refresh)
      await combatant.setFlag('fantastic-depths-combat-carousel', 'waitingForRound', true);
      console.log(`FDCC:main | createCombatant | ${combatant.name} | waitingForRound set to true`);
      
      // Set default action to "nothing" and mark as chosen to avoid blocking carousel flow
      if (combatant.actor) {
        await combatant.actor.update({ 'system.combat.declaredAction': 'nothing' });
        await combatant.setFlag('fantastic-depths-combat-carousel', 'choseNothing', true);
      }

      // Pre-align the carousel's active index with the preserved active combatant so the
      // first refresh after the join doesn't flash onto the newly added combatant.
      if (activeBeforeId && combat.combatant?.id === activeBeforeId) {
        const sortedIdx = carousel.sortedCombatants.findIndex(c => c.id === activeBeforeId);
        if (sortedIdx >= 0 && sortedIdx !== carousel._sortedTurnIdx) {
          carousel._sortedTurnIdx = sortedIdx;
        }
      }

      // Restore the active turn to the combatant that was active before the join.
      // combat.turns re-sorts asynchronously after the initiative assignment; use a polling
      // loop so we keep correcting the turn until the active combatant is the one we captured.
      if (activeBeforeId) {
        let attempts = 0;
        const maxAttempts = 12;
        const tryRestore = () => {
          const combatNow = carousel.combat;
          if (!combatNow || carousel._roundChanging) return;
          const currentActiveId = combatNow.combatant?.id;
          if (currentActiveId === activeBeforeId) {
            // The active combatant is correct, but its index in sortedCombatants may have changed
            // because combat.turns re-sorted. Synchronize _sortedTurnIdx and refresh so the
            // carousel active card matches the real active combatant.
            const sortedIdx = carousel.sortedCombatants.findIndex(c => c.id === activeBeforeId);
            if (sortedIdx >= 0 && sortedIdx !== carousel._sortedTurnIdx) {
              console.log(`FDCC:main | createCombatant | syncing _sortedTurnIdx (${carousel._sortedTurnIdx} -> ${sortedIdx}) for restored ${activeBeforeName}`);
              carousel._sortedTurnIdx = sortedIdx;
              carousel.refreshCards();
              carousel._scrollToActive();
              carousel._updateRoundIndicator();
            }
            console.log(`FDCC:main | createCombatant | active combatant restored (${activeBeforeName})`);
            carousel._midRoundJoinActiveId = null;
            return;
          }
          const turnIdx = combatNow.turns.findIndex(c => c.id === activeBeforeId);
          if (turnIdx >= 0 && turnIdx !== combatNow.turn) {
            console.log(`FDCC:main | createCombatant | restoring active combatant=${activeBeforeName} (turn=${combatNow.turn} -> ${turnIdx}) attempt=${attempts + 1}`);
            combatNow.update({ turn: turnIdx });
          }
          attempts++;
          if (attempts < maxAttempts) {
            setTimeout(tryRestore, 250);
          } else {
            console.log(`FDCC:main | createCombatant | gave up restoring active combatant=${activeBeforeName}`);
          }
        };
        setTimeout(tryRestore, 250);
      }
    }
    // Special handling for individual modes when combatant joins after round 0
    else if (combat?.started && combat.round > 0 && carousel.isIndividualMode) {
      console.log(`FDCC:main | createCombatant | ${combatant.name} | round=${combat.round} | mode=${carousel.initiativeMode} (individual)`);
      
      // Mark new combatant as waiting for next round FIRST (before any carousel refresh)
      await combatant.setFlag('fantastic-depths-combat-carousel', 'waitingForRound', true);
      console.log(`FDCC:main | createCombatant | ${combatant.name} | waitingForRound set to true for individual mode`);
      
      // For individual modes with declaredAction (individualChecklist), apply same fix as group modes
      if (carousel.initiativeMode === 'individualChecklist') {
        // Set default action to "nothing" and mark as chosen to avoid blocking carousel flow
        if (combatant.actor) {
          await combatant.actor.update({ 'system.combat.declaredAction': 'nothing' });
          await combatant.setFlag('fantastic-depths-combat-carousel', 'choseNothing', true);
        }
        console.log(`FDCC:main | createCombatant | ${combatant.name} | choseNothing set for individualChecklist mode`);
      }
      
      // For all individual modes, let the combatant roll initiative normally
      // Don't interfere with the round flow - let Foundry handle positioning
      // The combatant will now appear with yellow hourglass and darkened card due to waitingForRound flag
    }
    
    // Single refresh at the end to update UI properly
    carousel.setupCombatants();
  } else {
    // Carousel was destroyed (e.g. all combatants removed) — re-create it if a combat exists
    const combat = combatant.combat ?? game.combat;
    if (combat && combat.combatants.size > 0) {
      new CombatCarousel(combat).render(true);
    }
  }
});

Hooks.on('deleteCombatant', () => {
  const carousel = ui.combatCarousel;
  if (!carousel) return;
  const combat = carousel.combat;
  if (!combat || combat.combatants.size === 0) {
    // No combatants left — close carousel
    carousel.destroy();
    if (combat?.started) {
      // Combat was active — ask about XP, then delete combat silently (skip endCombat dialog)
      foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize('FDCC.ConfirmRemoveLastTitle') },
        content: `<p>${game.i18n.localize('FDCC.ConfirmRemoveLastContent')}</p>`,
        yes: { default: false }
      }).then(async (awardXP) => {
        if (awardXP) {
          // Let FaDe's endCombat handle XP awarding
          await combat.endCombat();
        } else {
          // Flag combat to skip XP processing, then delete silently
          await combat.setFlag('fantastic-depths-combat-carousel', 'skipXP', true);
          await combat.delete();
        }
      });
    }
    return;
  }
  carousel.setupCombatants();
});

Hooks.on('updateCombatant', (combatant, updates) => {
  if (!ui.combatCarousel) return;
  if ('initiative' in updates || 'hidden' in updates) {
    ui.combatCarousel.setupCombatants();
    // If this combatant now has a decimal initiative, it has completed
    // its tie reroll — remove it from _pendingTieRerolls immediately (don't wait for socket).
    if ('initiative' in updates) {
      const carousel = ui.combatCarousel;
      const init = combatant.initiative;
      const wasInPending = carousel._pendingTieRerolls?.has(combatant.id);
      if (wasInPending && init != null && !Number.isInteger(init)) {
        carousel._pendingTieRerolls.delete(combatant.id);
        // GM broadcasts to clients so they also remove from pending
        if (game.user.isGM) {
          const socketName = `module.fantastic-depths-combat-carousel`;
          game.socket.emit(socketName, { action: 'markTieRerolled', combatId: combat.id, combatantId: combatant.id, round: combat.round });
        }
      }
      if (carousel._pendingTieRerolls?.size > 0 || wasInPending) {
        carousel.refreshCards();
      }
    }
    // After initiative reroll resolves duplicates, reset turn order (GM only)
    // detectTies() is called AFTER this block so _pendingTieRerolls still reflects pre-update state
    if ('initiative' in updates && game.user.isGM && ui.combatCarousel.combat?.started) {
      const mode = ui.combatCarousel.initiativeMode;
      if (mode === 'individualChecklist' || mode === 'simpleIndividual' || mode === 'individual') {
        // Defer so Foundry finishes re-sorting combat.turns after all initiative updates settle
        const roundAtSchedule = ui.combatCarousel.combat?.round;
        setTimeout(() => {
          const carousel = ui.combatCarousel;
          if (!carousel) return;
          // Abort if round changed since this timeout was scheduled, or round is changing, or ties pending
          if (carousel.combat?.round !== roundAtSchedule) return;
          if (carousel._roundChanging) return;
          if (carousel._pendingTieRerolls?.size > 0) return;
          const initiatives = carousel.combat.combatants.map(c => c.initiative).filter(i => i != null);
          const allRolled = initiatives.length === carousel.combat.combatants.size;
          const integerInits = initiatives.filter(i => Number.isInteger(i));
          const hasDuplicates = integerInits.length !== new Set(integerInits).size;
          if (allRolled && !hasDuplicates) {
            const sorted = carousel.sortedCombatants;
            const firstCombatant = sorted[0];
            if (firstCombatant) {
              const combat = carousel.combat;
              // CRITICAL FIX: Don't reset turn to first combatant during mid-round individual modes.
              // If combat has started, preserve the currently active combatant after re-ordering.
              // Only reset to the first combatant if combat is not yet started (or has no active turn).
              const currentActive = combat.turns[combat.turn];
              if (!combat.started || !currentActive) {
                const turnIdx = combat.turns.findIndex(c => c.id === firstCombatant.id);
                if (turnIdx >= 0 && turnIdx !== combat.turn) {
                  console.log(`FDCC | updateCombatant | resetting turn to first=${firstCombatant.name} (combat not started)`);
                  combat.update({ turn: turnIdx });
                }
              } else {
                const turnIdx = combat.turns.findIndex(c => c.id === currentActive.id);
                if (turnIdx >= 0 && turnIdx !== combat.turn) {
                  console.log(`FDCC | updateCombatant | preserving active combatant=${currentActive.name} (turn=${combat.turn} -> ${turnIdx})`);
                  combat.update({ turn: turnIdx });
                } else {
                  console.log(`FDCC | updateCombatant | skipping turn reset - active combatant unchanged (turn=${combat.turn})`);
                }
              }
            }
          }
        }, 500);
      } else if (mode === 'group' || mode === 'advancedGroup') {
        // In group mode the carousel tracks its own sorted index (_sortedTurnIdx)
        // No need to update combat.turn — just refresh the carousel display
        ui.combatCarousel.setupCombatants();
      }
    }
    // Slow weapon rule (GM only): if a slow combatant just received an integer initiative,
    // immediately override it with 0 + (roll/100) so slow combatants always go last.
    if ('initiative' in updates && game.user.isGM) {
      const mode = ui.combatCarousel?.initiativeMode;
      if (mode === 'individual' || mode === 'individualChecklist') {
        const init = combatant.initiative;
        if (init != null && Number.isInteger(init)) {
          const items = combatant.actor?.items;
          const hasSlowEquipped = items?.some(i =>
            i.type === 'weapon' && i.system?.equipped === true && i.system?.isSlow === true
          );
          if (hasSlowEquipped) {
            const slowInit = Math.round(init / 100 * 100) / 100;
            combatant.update({ initiative: slowInit });
            return;
          }
        }
      }
    }
    // Detect ties AFTER the turn-order block so _pendingTieRerolls reflects pre-update state there
    // Use debounce to prevent race conditions during initiative rerolls
    if ('initiative' in updates && (ui.combatCarousel.initiativeMode === 'individualChecklist' || ui.combatCarousel.initiativeMode === 'simpleIndividual' || ui.combatCarousel.initiativeMode === 'individual')) {
      clearTimeout(ui.combatCarousel._detectTiesTimeout);
      ui.combatCarousel._detectTiesTimeout = setTimeout(() => ui.combatCarousel.detectTies(), 100);
    }
  } else {
    ui.combatCarousel.updateSingleCard(combatant);
  }
});

Hooks.on('updateActor', (actor, changes) => {
  if (!ui.combatCarousel?.rendered) return;
  // HP changes: just refresh cards (lightweight)
  if (changes.system?.hp !== undefined || changes.system?.attributes?.hp !== undefined) {
    ui.combatCarousel.refreshCards();
  }
  // declaredAction changes: handled by CombatCarousel._setHooks updateActor handler
});

/** True if the item belongs to an actor currently in the carousel combat. */
function _itemBelongsToCarouselCombatant(item) {
  const carousel = ui.combatCarousel;
  if (!carousel?.rendered || !carousel.combat) return false;
  const actor = item?.actor ?? item?.parent;
  if (!actor || actor.documentName !== 'Actor') return false;
  return carousel.combat.combatants.some(c => c.actor?.id === actor.id);
}

// Match FaDe PlayerCombatForm: any item change on a combatant can alter available actions
// (equipped weapons, ammo, memorized spells, special-ability maneuvers, etc.).
Hooks.on('updateItem', (item) => {
  if (_itemBelongsToCarouselCombatant(item)) ui.combatCarousel.refreshCards();
});

Hooks.on('createItem', (item) => {
  if (_itemBelongsToCarouselCombatant(item)) ui.combatCarousel.refreshCards();
});

Hooks.on('deleteItem', (item) => {
  if (_itemBelongsToCarouselCombatant(item)) ui.combatCarousel.refreshCards();
});

Hooks.on('hoverToken', (token, hover) => {
  if (!ui.combatCarousel?.rendered) return;
  const card = ui.combatCarousel.element?.querySelector(
    `.combatant-card[data-token-id="${token.document?.id ?? token.id}"]`
  );
  if (card) card.classList.toggle('hovered', hover);
});
