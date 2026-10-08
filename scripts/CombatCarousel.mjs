import { CombatantCard } from './CombatantCard.mjs';
import { forceActionReselect } from './settings.mjs';

const MODULE_ID = 'fantastic-depths-combat-carousel';

// DEBUG: Verify module is loading
console.log(`FDCC | CombatCarousel.mjs | LOADING - ${new Date().toISOString()}`);

// FINAL SOLUTION: Global audio interception for GM turn sound blocking
if (typeof game !== 'undefined' && game.user?.isGM) {
  const originalAudioPlay = game.audio.play.bind(game.audio);
  game.audio.play = function(src, options = {}) {
    // Block turn sounds for GM only
    if (src && typeof src === 'string' && src.includes('epic-turn-1hit.ogg')) {
      console.log(`FDCC | GLOBAL AUDIO BLOCK | Blocked turn sound for GM: ${src}`);
      return Promise.resolve();
    }
    // Allow all other sounds (combat start, new round, etc.)
    return originalAudioPlay(src, options);
  };
  console.log(`FDCC | GLOBAL AUDIO INTERCEPTION | Active for GM`);
}

function _isDebug() {
  try { return game.settings.get(MODULE_ID, 'debugMode'); } catch(e) { return false; }
}
function _log(...args) {
  if (!_isDebug()) return;
  console.log(`%cFDCC |`, 'color:#0cf; font-weight:bold', ...args);
}
function _warn(...args) {
  if (!_isDebug()) return;
  console.warn(`%cFDCC |`, 'color:#fa0; font-weight:bold', ...args);
}

// Combat Sequence Checklist phase order for group mode
// Keys must match FaDe's declaredAction values (FADE.combat.maneuvers.*)
const ACTION_PHASE_ORDER = {
  morale: 1,
  moveOnly: 2,
  readyWeapon: 2,
  retreat: 2,
  withdrawal: 2,
  fire: 3,
  throw: 3,
  magicItem: 4,
  spell: 4,
  concentrate: 4,
  setSpear: 5,
  lance: 5,
  attack: 5,
  multiAttack: 5,
  smash: 5,
  slow: 6,  // AdvancedGroup: slow weapons act after normal melee
  nothing: 99
};

/**
 * Check if combatant has a slow weapon equipped that matches the declared action.
 * - For 'attack': needs weapon with isSlow=true AND canMelee=true
 * - For 'fire'/'throw': needs weapon with isSlow=true AND canRanged=true
 */
function hasSlowWeaponForAction(combatant, action) {
  const items = combatant.actor?.items;
  if (!items) return false;

  // Find equipped weapons with isSlow=true
  const equippedWeapons = items.filter(i =>
    i.type === 'weapon' &&
    i.system?.equipped === true &&
    i.system?.isSlow === true
  );

  if (equippedWeapons.length === 0) return false;

  // Check based on action type
  if (action === 'attack') {
    // For attack: need weapon with canMelee=true
    return equippedWeapons.some(w => w.system?.canMelee === true);
  } else if (action === 'fire' || action === 'throw') {
    // For fire/throw: need weapon with canRanged=true
    return equippedWeapons.some(w => w.system?.canRanged === true);
  }

  return false;
}

function getActionPhase(combatant, initiativeMode) {
  const action = combatant.actor?.system?.combat?.declaredAction;

  // individual mode: no declared actions, check if any slow weapon is equipped
  if (initiativeMode === 'individual') {
    const items = combatant.actor?.items;
    if (items) {
      const hasSlowEquipped = items.some(i =>
        i.type === 'weapon' &&
        i.system?.equipped === true &&
        i.system?.isSlow === true
      );
      if (hasSlowEquipped) return ACTION_PHASE_ORDER.slow;
    }
    return 99; // No action = nothing phase
  }

  if (!action) return 99;

  // AdvancedGroup and individualChecklist modes: check for slow weapons on attack/fire/throw actions
  if ((initiativeMode === 'advancedGroup' || initiativeMode === 'individualChecklist') && (action === 'attack' || action === 'fire' || action === 'throw')) {
    // Check if combatant has a slow weapon equipped that matches the action type
    if (hasSlowWeaponForAction(combatant, action)) {
      return ACTION_PHASE_ORDER.slow; // 6 - acts after normal melee
    }
  }

  return ACTION_PHASE_ORDER[action] ?? 99;
}

/**
 * CombatCarousel - Pure DOM-based combat carousel docked at top of screen.
 * Does not extend ApplicationV2 to avoid template/rendering issues.
 */
export class CombatCarousel {

  constructor(combat) {
    if (ui.combatCarousel) {
      ui.combatCarousel.destroy();
    }
    ui.combatCarousel = this;
    this.combat = combat ?? game.combat;
    this.cards = [];
    this._hooks = [];
    this.element = null;
    this.rendered = false;
    this._pendingTieRerolls = new Set(); // combatant IDs that still need to reroll in a tie
    this._resolvedTiePairs = new Set(); // Set of "idA|idB" strings for ties that have been resolved
    this._resolvingTies = false; // guard against re-entrant detectTies calls
    // Restore sorted turn index from combat flags (survives F5)
    const savedIdx = (combat ?? game.combat)?.getFlag('fantastic-depths-combat-carousel', 'sortedTurnIdx');
    this._sortedTurnIdx = (typeof savedIdx === 'number') ? savedIdx : 0;
    // In two-phase mode, align with the current Foundry combat.turn instead of the saved flag
    if (this.isGroupMode && this.combat?.turns?.length) {
      this._sortedTurnIdx = this._getSortedIdxForTurn(this.combat.turn ?? 0);
    }
    // Shadow state for NPC actions synced via socket (bypasses Foundry permission restrictions)
    this._npcActions = new Map(); // combatantId -> action
  }

  get sortedCombatants() {
    // In individual, individualChecklist and simpleIndividual modes, follow combat.turns order
    // (which FaDe sorts by action phase then initiative, matching the Combat Sequence Checklist)
    if (this.initiativeMode === 'individual' || this.initiativeMode === 'individualChecklist' || this.initiativeMode === 'simpleIndividual' || this.isGroupMode) {
      if (this.combat?.turns?.length) {
        const seen = new Set();
        const ordered = [];
        for (const c of this.combat.turns) {
          if (!seen.has(c.id)) {
            seen.add(c.id);
            ordered.push(c);
          }
        }
        // Fallback: append any combatants not present in combat.turns
        for (const c of this.combat.combatants.contents) {
          if (!seen.has(c.id)) ordered.push(c);
        }
        return ordered;
      }
      // Fallback if combat.turns is empty: sort by initiative desc
      return Array.from(this.combat.combatants.contents).sort((a, b) => {
        const ai = a.initiative ?? -Infinity;
        const bi = b.initiative ?? -Infinity;
        if (bi !== ai) return bi - ai;
        return a.name.localeCompare(b.name);
      });
    }
    // In two-phase mode, use the order defined by Foundry/FaDe in combat.turns (first occurrence of each combatant)
    if (this.isTwoPhaseMode && this.combat?.turns?.length) {
      const seen = new Set();
      const ordered = [];
      for (const c of this.combat.turns) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          ordered.push(c);
        }
      }
      // Fallback: append any combatants not present in combat.turns
      for (const c of this.combat.combatants.contents) {
        if (!seen.has(c.id)) ordered.push(c);
      }
      return ordered;
    }
    // In group/checklist modes, sort by initiative (desc) then combat sequence phase
    if (this.isGroupMode) {
      return Array.from(this.combat.combatants.contents).sort((a, b) => {
        const ai = a.initiative ?? -Infinity;
        const bi = b.initiative ?? -Infinity;
        if (bi !== ai) return bi - ai;
        const pa = getActionPhase(a, this.initiativeMode);
        const pb = getActionPhase(b, this.initiativeMode);
        if (pa !== pb) return pa - pb;

        // Within slow phase (6), order by original action: fire/throw before attack
        if (pa === ACTION_PHASE_ORDER.slow) {
          const aa = a.actor?.system?.combat?.declaredAction;
          const ba = b.actor?.system?.combat?.declaredAction;
          const aIsMissile = aa === 'fire' || aa === 'throw';
          const bIsMissile = ba === 'fire' || ba === 'throw';
          if (aIsMissile && !bIsMissile) return -1; // a (missile) before b (melee)
          if (!aIsMissile && bIsMissile) return 1;  // b (missile) before a (melee)
        }

        return a.name.localeCompare(b.name);
      });
    }
    return Array.from(this.combat.combatants.contents.sort(this.combat._sortCombatants));
  }

  get initiativeMode() {
    return game.settings.get(game.system.id, 'initiativeMode');
  }

  get isGroupMode() {
    return ['group', 'advancedGroup'].includes(this.initiativeMode);
  }

  get isIndividualMode() {
    return ['individual', 'individualChecklist', 'simpleIndividual'].includes(this.initiativeMode);
  }

  get isAdvancedGroupMode() {
    return this.initiativeMode === 'advancedGroup';
  }

  get isTwoPhaseMode() {
    return this.initiativeMode === 'advancedGroup';
  }

  _getGroupInitiative(combatant) {
    if (!this.isGroupMode) return null;
    
    // Determine the combatant's group (hostile/friend/neutral)
    const disposition = combatant.token?.disposition ?? CONST.TOKEN_DISPOSITIONS.NEUTRAL;
    let groupKey;
    if (disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE) {
      groupKey = 'hostile';
    } else if (disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY) {
      groupKey = 'friend';
    } else {
      groupKey = 'neutral';
    }
    
    // Find existing combatants of the same group with a valid initiative
    const sameGroupCombatants = this.combat.combatants.filter(c => {
      if (c.id === combatant.id) return false;
      const cDisposition = c.token?.disposition ?? CONST.TOKEN_DISPOSITIONS.NEUTRAL;
      let cGroupKey;
      if (cDisposition === CONST.TOKEN_DISPOSITIONS.HOSTILE) {
        cGroupKey = 'hostile';
      } else if (cDisposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY) {
        cGroupKey = 'friend';
      } else {
        cGroupKey = 'neutral';
      }
      return cGroupKey === groupKey && c.initiative != null;
    });
    
    if (sameGroupCombatants.length === 0) return null;
    
    // Return the initiative value of the first same-group combatant
    return sameGroupCombatants[0].initiative;
  }

  /**
   * For two-phase (advancedGroup) mode: determine which phase (1 or 2) a given turn index represents.
   * Each combatant appears twice in combat.turns; the first occurrence is phase 1, the second phase 2.
   */
  _getPhaseForTurn(turnIdx) {
    const turns = this.combat?.turns;
    if (!turns || !turns.length) return 1;
    const combatant = turns[turnIdx];
    if (!combatant) return 1;
    let count = 0;
    for (let i = 0; i <= turnIdx; i++) {
      if (turns[i].id === combatant.id) count++;
    }
    return count;
  }

  /**
   * For two-phase (advancedGroup) mode: map the active combat.turn index to the sortedCombatants index.
   */
  _getSortedIdxForTurn(turnIdx) {
    // Prefer Foundry's active combatant (the single source of truth shown in the core tracker).
    // In two-phase mode, combat.combatant is the current phase's active combatant.
    const active = this.combat?.combatant ?? this.combat?.turns?.[turnIdx];
    if (!active) return this._sortedTurnIdx;
    const idx = this.sortedCombatants.findIndex(c => c.id === active.id);
    return idx >= 0 ? idx : this._sortedTurnIdx;
  }

  render(force = false) {
    if (this.rendered && !force) return this;
    this._buildDOM();
    this._appendToUI();
    this.setupCombatants();
    this._activateControlListeners();
    this._setHooks();
    this.rendered = true;
    // Ensure the canvas selection matches the active carousel combatant after F5/reload
    if (this.combat?.started) {
      setTimeout(() => {
        this._selectActiveToken();
        this._guardTokenSelection(1000);
      }, 100);
    }
    let nextRound = 'reset';
    try { nextRound = game.settings.get(game.system.id, 'nextRound') ?? 'reset'; } catch(e) {}
    let initFormula = '?';
    try { initFormula = game.settings.get(game.system.id, 'initiativeFormula') ?? '?'; } catch(e) {}
    return this;
  }

  _buildDOM() {
    if (this.element) this.element.remove();

    const isGM = game.user.isGM;
    const portraitSize = game.settings.get('fantastic-depths-combat-carousel', 'portraitSize');
    const el = document.createElement('div');
    el.id = 'combat-carousel-panel';
    el.classList.add('combat-carousel-panel', 'docked-top');
    el.style.setProperty('--portrait-size', `${portraitSize}px`);

    let html = '';

    const initModeTooltip = this._getInitModeTooltip();
    const nextRoundTooltip = this._getNextRoundTooltip();
    const initLabel = game.i18n.lang === 'it' ? 'INIZIATIVA' : 'INITIATIVE';
    const phase = this.isTwoPhaseMode ? this._getPhaseForTurn(this.combat.turn ?? 0) : null;
    html += `
    <div class="carousel-round-indicator">
      <span class="initiative-label">
        ${initLabel}
        <i class="fas fa-circle-info round-info-icon" data-tooltip="${initModeTooltip}"></i>
      </span>
      <span class="round-label">
        ${game.i18n.localize('FDCC.Round')}
        <i class="fas fa-circle-info round-info-icon round-mode-icon" data-tooltip="${nextRoundTooltip}"></i>
      </span>
      <span class="round-number">${this.combat.round ?? 0}</span>
      ${phase ? `<span class="phase-label">${game.i18n.localize('FDCC.Phase')}</span><span class="phase-number">${phase}</span>` : ''}
    </div>`;

    if (isGM) {
      html += `
      <div class="carousel-controls left">
        <button type="button" data-action="previous-turn" data-tooltip="${game.i18n.localize('FDCC.Controls.PrevTurn')}">
          <i class="fas fa-backward-step"></i>
        </button>
        <button type="button" data-action="previous-round" data-tooltip="${game.i18n.localize('FDCC.Controls.PrevRound')}">
          <i class="fas fa-backward"></i>
        </button>
      </div>`;
    }

    html += `<div id="carousel-combatants" class="carousel-combatants"></div>`;

    if (isGM) {
      const showGMRollPcs = this.isGroupMode ? '' : 'display:none';
      html += `
      <div class="carousel-controls right">
        <div class="controls-column">
          <button type="button" data-action="roll-all" data-tooltip="${game.i18n.localize('FDCC.Controls.RollAll')}">
            <i class="fas fa-dice"></i>
          </button>
          <button type="button" data-action="roll-pcs" class="roll-pcs-btn" data-tooltip="${game.i18n.localize('FDCC.Controls.RollPCs')}" style="${showGMRollPcs}" disabled>
            <i class="fas fa-dice"></i>
          </button>
          <button type="button" data-action="roll-npc" data-tooltip="${game.i18n.localize('FDCC.Controls.RollNPC')}">
            <i class="fas fa-users"></i>
          </button>
          <button type="button" data-action="reset-initiative" data-tooltip="${game.i18n.localize('FDCC.Controls.ResetInitiative')}">
            <i class="fas fa-rotate-left"></i>
          </button>
          <button type="button" data-action="start-combat" data-tooltip="${game.i18n.localize('FDCC.Controls.StartCombat')}" style="${this.combat.started ? 'display:none' : ''}">
            <i class="fas fa-swords"></i>
          </button>
        </div>
        <div class="controls-column">
          <button type="button" data-action="next-turn" data-tooltip="${game.i18n.localize('FDCC.Controls.NextTurn')}">
            <i class="fas fa-forward-step"></i>
          </button>
          <button type="button" data-action="next-round" data-tooltip="${game.i18n.localize('FDCC.Controls.NextRound')}">
            <i class="fas fa-forward"></i>
          </button>
          <button type="button" data-action="end-combat" data-tooltip="${game.i18n.localize('FDCC.Controls.EndCombat')}">
            <i class="fas fa-xmark"></i>
          </button>
        </div>
      </div>`;
    } else if (this.isGroupMode) {
      html += `
      <div class="carousel-controls right">
        <button type="button" data-action="roll-pcs" class="roll-pcs-btn" data-tooltip="${game.i18n.localize('FDCC.Controls.RollPCs')}" disabled>
          <i class="fas fa-dice"></i>
        </button>
      </div>`;
    }


    el.innerHTML = html;
    this.element = el;
  }

  _getInitModeTooltip() {
    const isIT = game.i18n.lang === 'it';
    const mode = this.initiativeMode;
    if (mode === 'individual')         return isIT ? 'INDIVIDUALE' : 'INDIVIDUAL';
    if (mode === 'simpleIndividual') return isIT ? 'INDIVIDUALE Semplificata' : 'INDIVIDUAL Simplified';
    if (mode === 'individualChecklist') return isIT ? 'INDIVIDUALE Azioni dichiarate' : 'INDIVIDUAL Combat Checklist';
    if (mode === 'group')              return isIT ? 'GRUPPO Azioni dichiarate' : 'GROUP Combat Checklist';
    if (mode === 'advancedGroup')      return isIT ? 'GRUPPO Sequenza in 2 Fasi' : 'GROUP 2-part sequence';
    return mode;
  }

  _getNextRoundTooltip() {
    const isIT = game.i18n.lang === 'it';
    let value = 'reset';
    try { value = game.settings.get(game.system.id, 'nextRound') ?? 'reset'; } catch(e) {}
    const labels = {
      hold:   isIT ? 'Mantieni Iniziativa' : 'Hold Initiative',
      reset:  isIT ? 'Azzera Iniziativa' : 'Reset Initiative',
      reroll: isIT ? 'Iniziativa Automatica' : 'Reroll Initiative'
    };
    return labels[value] ?? value;
  }

  _appendToUI() {
    const uiTop = document.querySelector('#ui-top');
    if (uiTop && this.element) {
      uiTop.prepend(this.element);
    }
  }

  setupCombatants() {
    const container = this.element?.querySelector('#carousel-combatants');
    if (!container) return;

    container.innerHTML = '';
    this.cards = [];

    const combatants = this.sortedCombatants;
    const allHaveInit = !this.combat.combatants.some(c => c.initiative == null);
    const allActionsChosen = !this._hasUnselectedActions();
    const initiatives = this.combat.combatants.map(c => c.initiative).filter(i => i != null);
    const hasDuplicates = initiatives.length !== new Set(initiatives).size;
    const hasPendingRerolls = this._pendingTieRerolls.size > 0;
    let suppressActive = false;
    if (this.initiativeMode === 'individual' || this.initiativeMode === 'individualChecklist' || this.initiativeMode === 'simpleIndividual') {
      suppressActive = !allHaveInit || hasDuplicates || hasPendingRerolls;
    } else if (this.isGroupMode) {
      suppressActive = !allHaveInit || !allActionsChosen;
    }
    const useInternalIdx = this.isGroupMode && this.combat.started && !suppressActive;
    const currentId = useInternalIdx
      ? (combatants[this._sortedTurnIdx]?.id ?? null)
      : (!suppressActive && this.combat.started) ? this.combat.combatant?.id : null;

    combatants.forEach((combatant) => {
      // Hide hidden combatants from players
      if (!game.user.isGM && combatant.hidden) return;
      const card = new CombatantCard(combatant, {
        isActive: currentId ? combatant.id === currentId : false,
        combat: this.combat
      });
      this.cards.push(card);
      container.appendChild(card.wrapper);
    });

    this._updateRoundIndicator();
    this._updateStartEndButtons();
    this._updateRollPCsButton();
    this._updateGMRollButtons();
    this._updateStartCombatButton();
    this._checkDiceFacesWarning();
    this._autoRollIfReady();
  }

  updateSingleCard(combatant) {
    const card = this.cards.find(c => c.combatant === combatant);
    if (card) card.refresh();
  }

  _shouldSuppressActive() {
    if (!this.combat) return true;
    const allHaveInit = !this.combat.combatants.some(c => c.initiative == null);
    const allActionsChosen = !this._hasUnselectedActions();
    const initiatives = this.combat.combatants.map(c => c.initiative).filter(i => i != null);
    const hasDuplicates = initiatives.length !== new Set(initiatives).size;
    const hasPendingRerolls = this._pendingTieRerolls.size > 0;
    if (this.initiativeMode === 'individual' || this.initiativeMode === 'individualChecklist' || this.initiativeMode === 'simpleIndividual') {
      return !allHaveInit || hasDuplicates || hasPendingRerolls;
    }
    if (this.isGroupMode) {
      return !allHaveInit || !allActionsChosen;
    }
    return false;
  }

  refreshCards() {
    // Reorder cards in DOM to match current initiative order (important after tie-rerolls)
    this._reorderCardsByInitiative();
    const suppressActive = this._shouldSuppressActive();
    const useInternalIdx2 = this.isGroupMode && this.combat.started && !suppressActive;
    const currentId2 = useInternalIdx2
      ? (this.sortedCombatants[this._sortedTurnIdx]?.id ?? null)
      : (!suppressActive && this.combat.started) ? this.combat.combatant?.id : null;
    this.cards.forEach(card => {
      card.isActive = currentId2 ? card.combatant.id === currentId2 : false;
      card.refresh();
    });
    this._updateRoundIndicator();
    this._updateStartEndButtons();
    this._updateRollPCsButton();
    this._updateGMRollButtons();
    this._updateStartCombatButton();
    this._scrollToActiveCard();
    this._autoRollIfReady();
  }

  _scrollToActiveCard() {
    const container = this.element?.querySelector('.carousel-combatants');
    if (!container) return;
    const activeCard = container.querySelector('.combatant-card.active');
    if (!activeCard) return;
    const containerRect = container.getBoundingClientRect();
    const cardRect = activeCard.getBoundingClientRect();
    const scrollLeft = activeCard.offsetLeft - container.offsetLeft - (containerRect.width / 2) + (cardRect.width / 2);
    container.scrollTo({ left: scrollLeft, behavior: 'smooth' });
  }

  /**
   * Select and pan to the token of the active combatant.
   * Ensures the scene selection follows the carousel turn.
   */
  _selectActiveToken() {
    console.log(`FDCC | TOKEN DEBUG | _selectActiveToken called | user=${game.user.name} | combatStarted=${this.combat?.started} | isGroupMode=${this.isGroupMode} | combat.turn=${this.combat?.turn ?? '?'}`);
    if (!this.combat?.started) {
      console.log(`FDCC | TOKEN DEBUG | combat not started — abort`);
      return;
    }
    if (this._shouldSuppressActive()) {
      console.log(`FDCC | TOKEN DEBUG | active state not stable (initiatives/actions not ready) — abort token selection`);
      return;
    }
    // In two-phase mode, mirror Foundry's active combatant exactly.
    if (this.isTwoPhaseMode && this.combat.combatant) {
      const idx = this.sortedCombatants.findIndex(c => c.id === this.combat.combatant.id);
      if (idx >= 0) this._sortedTurnIdx = idx;
    }
    // In group mode, the carousel uses its own sorted index; in individual modes, use Foundry's combat.combatant
    const active = this.isGroupMode ? this.sortedCombatants?.[this._sortedTurnIdx] : this.combat.combatant;
    console.log(`FDCC | TOKEN DEBUG | active combatant=${active?.name ?? 'null'} | sortedTurnIdx=${this._sortedTurnIdx} | combat.turn=${this.combat?.turn ?? '?'}`);
    if (!active) return;
    const token = active.token?.object;
    console.log(`FDCC | TOKEN DEBUG | token object=${token ? 'found' : 'null'} | visible=${token?.visible} | token.id=${token?.id}`);
    if (!token || !token.visible) {
      console.log(`FDCC | TOKEN DEBUG | token missing or not visible — abort`);
      return;
    }
    const canObserve = active.actor?.testUserPermission(game.user, 'OBSERVER');
    console.log(`FDCC | TOKEN DEBUG | canObserve=${canObserve}`);
    if (!canObserve) return;
    try {
      const beforeSelected = canvas.tokens?.controlled?.map(t => t.name).join(', ') ?? 'none';
      const released = canvas.tokens?.controlled?.length ?? 0;
      canvas.tokens.releaseAll();
      token.control({ releaseOthers: true });
      canvas.animatePan(token.center);
      console.log(`FDCC | TOKEN DEBUG | SUCCESS | selected ${active.name} | releasedPrevious=${released} | before=[${beforeSelected}]`);
      // Two-phase safety: verify selection after short delays and retry if something else stole it
      if (this.isTwoPhaseMode) {
        const expectedId = token.id;
        const verifyAndRetry = (attempt) => {
          const selectedIds = canvas.tokens?.controlled?.map(t => t.id) ?? [];
          const stillSelected = selectedIds.includes(expectedId);
          console.log(`FDCC | TOKEN DEBUG | VERIFY-${attempt} | selected=[${selectedIds.join(', ')}] | expected=${active.name} (${expectedId}) | ok=${stillSelected}`);
          if (!stillSelected) {
            console.log(`FDCC | TOKEN DEBUG | RE-TRY-${attempt} | ${active.name} was deselected, re-selecting`);
            canvas.tokens.releaseAll();
            token.control({ releaseOthers: true });
          }
        };
        [50, 200, 500].forEach((delay, idx) => {
          setTimeout(() => verifyAndRetry(idx + 1), delay);
        });
      }
    } catch (e) {
      console.warn(`FDCC | TOKEN DEBUG | FAILED for ${active.name}:`, e);
    }
  }

  /**
   * Guard the token selection for a short period after a turn change.
   * Some systems or race conditions may steal the selection; this re-applies it.
   */
  _guardTokenSelection(durationMs = 2000) {
    if (this._tokenGuardInterval) clearInterval(this._tokenGuardInterval);
    if (this._shouldSuppressActive()) {
      console.log(`FDCC | TOKEN DEBUG | GUARD | skipped — active state not stable`);
      return;
    }
    // In two-phase mode, guard the token that Foundry considers active.
    if (this.isTwoPhaseMode && this.combat.combatant) {
      const idx = this.sortedCombatants.findIndex(c => c.id === this.combat.combatant.id);
      if (idx >= 0) this._sortedTurnIdx = idx;
    }
    const active = this.isGroupMode ? this.sortedCombatants?.[this._sortedTurnIdx] : this.combat.combatant;
    if (!active?.token?.object) return;
    const expectedId = active.token.object.id;
    const start = Date.now();
    this._tokenGuardInterval = setInterval(() => {
      const elapsed = Date.now() - start;
      const selectedIds = canvas.tokens?.controlled?.map(t => t.id) ?? [];
      const stillSelected = selectedIds.includes(expectedId);
      if (!stillSelected) {
        console.log(`FDCC | TOKEN DEBUG | GUARD | re-selecting ${active.name} (${expectedId}) | currently=[${selectedIds.join(', ')}] | elapsed=${elapsed}ms`);
        canvas.tokens.releaseAll();
        active.token.object.control({ releaseOthers: true });
      }
      if (elapsed >= durationMs) {
        clearInterval(this._tokenGuardInterval);
        this._tokenGuardInterval = null;
        console.log(`FDCC | TOKEN DEBUG | GUARD | ended after ${elapsed}ms`);
      }
    }, 100);
  }

  /**
   * Reorder card DOM elements to match sortedCombatants order (initiative descending)
   * This ensures physical left-to-right order matches initiative after tie-rerolls
   */
  _reorderCardsByInitiative() {
    const container = this.element?.querySelector('#carousel-combatants');
    if (!container || this.cards.length === 0) return;
    
    // Get current sorted order
    const sorted = this.sortedCombatants;
    const sortedIds = sorted.map(c => c.id);
    
    // Check if current card order matches sorted order
    const currentOrder = this.cards.map(c => c.combatant.id);
    const needsReorder = !currentOrder.every((id, idx) => id === sortedIds[idx]);
    
    if (!needsReorder) return;
    
    // Reorder this.cards array to match sortedCombatants
    this.cards.sort((a, b) => {
      const idxA = sortedIds.indexOf(a.combatant.id);
      const idxB = sortedIds.indexOf(b.combatant.id);
      return idxA - idxB;
    });
    
    // Reorder DOM elements to match new card array order
    this.cards.forEach(card => {
      container.appendChild(card.wrapper); // append moves to end, so we do in order
    });
    
  }

  _updateRoundIndicator() {
    const roundEl = this.element?.querySelector('.round-number');
    if (roundEl) roundEl.textContent = this.combat.round ?? 0;
    const roundIcon = this.element?.querySelector('.round-mode-icon');
    if (roundIcon) roundIcon.dataset.tooltip = this._getNextRoundTooltip();
    if (this.isTwoPhaseMode) {
      const phaseEl = this.element?.querySelector('.phase-number');
      if (phaseEl) phaseEl.textContent = this._getPhaseForTurn(this.combat.turn ?? 0);
    }
  }

  _updateStartEndButtons() {
    const startBtn = this.element?.querySelector('[data-action="start-combat"]');
    const endBtn = this.element?.querySelector('[data-action="end-combat"]');
    if (startBtn) startBtn.style.display = this.combat.started ? 'none' : '';
    if (endBtn) endBtn.style.display = '';
  }

  _activateControlListeners() {
    const buttons = this.element?.querySelectorAll('.carousel-controls button');
    if (buttons) {
      buttons.forEach(btn => {
        btn.addEventListener('click', (e) => {
          const action = e.currentTarget.dataset.action;
          this._handleControlAction(action, e);
        });
      });
    }

    // Event delegation for action select changes - prevents stale listener issues
    const container = this.element?.querySelector('#carousel-combatants');
    if (container) {
      container.addEventListener('change', (e) => {
        const select = e.target.closest('select[name="declaredAction"]');
        if (!select) return;
        // Find the card for this select
        const cardEl = select.closest('.combatant-card');
        if (!cardEl) return;
        const combatantId = cardEl.dataset.combatantId;
        const card = this.cards.find(c => c.combatant.id === combatantId);
        if (card) {
          e.stopPropagation();
          card._onActionChange(e, select);
        }
      });
    }

    this._activateDragScroll();
  }

  _activateDragScroll() {
    const container = this.element?.querySelector('.carousel-combatants');
    if (!container) return;
    let isDown = false;
    let startX;
    let scrollLeft;

    container.addEventListener('mousedown', (e) => {
      if (e.target.closest('select, button, .card-control, .active-indicator')) return;
      isDown = true;
      container.classList.add('dragging');
      startX = e.pageX - container.offsetLeft;
      scrollLeft = container.scrollLeft;
    });

    container.addEventListener('mouseleave', () => {
      isDown = false;
      container.classList.remove('dragging');
    });

    container.addEventListener('mouseup', () => {
      isDown = false;
      container.classList.remove('dragging');
    });

    container.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      e.preventDefault();
      const x = e.pageX - container.offsetLeft;
      const walk = (x - startX) * 1.5;
      container.scrollLeft = scrollLeft - walk;
    });
  }

  async _handleControlAction(action, event) {
    switch (action) {
      case 'previous-turn':
      case 'next-turn':
      case 'previous-round':
      case 'next-round':
        if (action === 'previous-turn' || action === 'previous-round') {
          // Always allow going back if combat has started
          if (!this.combat.started) return;
        } else if (!this._hasInitiativeRolled()) {
          ui.notifications.warn(game.i18n.localize('FDCC.WarnNoInitiative'));
          return;
        }
        if (action === 'previous-turn') this._previousTurn();
        else if (action === 'next-turn') this._nextTurn();
        else if (action === 'previous-round') this.combat.previousRound();
        else if (action === 'next-round') this.combat.nextRound();
        break;
      case 'roll-all':
        // Block roll-all in hold mode from round 2+
        {
          let nextRound = 'reset';
          try { nextRound = game.settings.get(game.system.id, 'nextRound') ?? 'reset'; } catch(e) {}
          if (nextRound === 'hold' && this.combat?.round > 1) {
            ui.notifications.warn(game.i18n.localize('FDCC.WarnRollNotAllowedHold'));
            return;
          }
        }
        if (this._hasUnselectedActions()) {
          ui.notifications.warn(game.i18n.localize('FDCC.WarnActionsNotSelected'));
          return;
        }
        // If all initiatives already rolled (individual modes): confirm before re-rolling
        if (this._allInitiativeRolled() && !this.isGroupMode) {
          const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: game.i18n.localize('FDCC.ConfirmRerollTitle') },
            content: `<p>${game.i18n.localize('FDCC.ConfirmRerollContent')}</p>`,
            yes: { default: true }
          });
          if (!confirmed) return;
          // Clear all initiatives and pending ties before re-rolling
          this._pendingTieRerolls.clear();
          const socketName = `module.${MODULE_ID}`;
          game.socket.emit(socketName, { action: 'clearTieRerolls', combatId: this.combat.id, round: this.combat.round });
          await Promise.all(Array.from(this.combat.combatants).map(c => c.update({ initiative: null })));
          this.refreshCards();
        }
        // CRITICAL FIX: Group modes should NOT include dexterity modifier
        if (this.isGroupMode) {
          await this._rollGroupInitiative();
        } else {
          await this._rollAllIndividual();
        }
        break;
      case 'roll-npc':
        // Block roll-npc in hold mode from round 2+
        {
          let nextRound = 'reset';
          try { nextRound = game.settings.get(game.system.id, 'nextRound') ?? 'reset'; } catch(e) {}
          if (nextRound === 'hold' && this.combat?.round > 1) {
            ui.notifications.warn(game.i18n.localize('FDCC.WarnRollNotAllowedHold'));
            return;
          }
        }
        if (this._hasNPCUnselectedActions()) {
          ui.notifications.warn(game.i18n.localize('FDCC.WarnActionsNotSelected'));
          return;
        }
        this._rollNPCInitiative();
        break;
      case 'roll-pcs':
        // Block roll-pcs in hold mode from round 2+
        {
          let nextRound = 'reset';
          try { nextRound = game.settings.get(game.system.id, 'nextRound') ?? 'reset'; } catch(e) {}
          if (nextRound === 'hold' && this.combat?.round > 1) {
            ui.notifications.warn(game.i18n.localize('FDCC.WarnRollNotAllowedHold'));
            return;
          }
        }
        if (this._hasPlayerUnselectedActions()) {
          ui.notifications.warn(game.i18n.localize('FDCC.WarnActionsNotSelected'));
          return;
        }
        this._rollPlayerInitiative();
        break;
      case 'reset-initiative':
        Promise.all(
          this.combat.combatants.map(c => c.update({ initiative: null }))
        ).then(() => this.refreshCards());
        break;
      case 'start-combat':
        if ((this._pendingTieRerolls?.size ?? 0) > 0) {
          ui.notifications.warn(game.i18n.localize('FDCC.WarnTiesMustBeResolved'));
          return;
        }
        if (this._hasUnselectedActions() && !this._hasInitiativeRolled()) {
          ui.notifications.warn(game.i18n.localize('FDCC.WarnActionsAndInitiative'));
          return;
        }
        if (this._hasUnselectedActions()) {
          ui.notifications.warn(game.i18n.localize('FDCC.WarnActionsNotSelected'));
          return;
        }
        if (!this._hasInitiativeRolled()) {
          ui.notifications.warn(game.i18n.localize('FDCC.WarnNoInitiative'));
          return;
        }
        this._startCombatPreservingActions();
        break;
      case 'end-combat':
        this.combat.endCombat();
        break;
    }
  }

  /**
   * Detect duplicate initiatives and mark tied combatants for a visible reroll.
   * Each tied combatant must roll once; their result is stored as base + (roll/100)
   * so the final order is: same integer, broken by the tie-reroll decimal.
   */
  async detectTies() {
    if (!game.user.isGM) return;
    if (this._resolvingTies) return;
    // Wait for all combatants to have rolled initiative before detecting ties
    if (!this._allInitiativeRolled()) return;
    // If a tie-reroll session is already in progress, do not interfere.
    // markTieRerolled() manages the pending set and calls detectTies() itself when all done.
    // Without this guard, the updateCombatant debounce would re-add a combatant that just
    // rerolled (initiative still shows as integer in local DB at this point).
    if (this._pendingTieRerolls.size > 0) return;
    // Group by integer part of initiative — combatants with same base value are potential ties.
    // This catches cases like: A=17 (integer, needs reroll) and B=17.18 (already rerolled).
    const initGroups = new Map();
    for (const c of this.combat.combatants) {
      if (c.initiative == null) continue;
      const base = Math.floor(c.initiative);
      if (!initGroups.has(base)) initGroups.set(base, []);
      initGroups.get(base).push(c.id);
    }
    // Collect combatants that still need to reroll:
    // Case 1: A group needs resolution if 2+ members share the same base AND at least one has integer initiative.
    //         Only those with integer initiative are added to pending (they haven't done their tie-reroll yet).
    // Case 2: After a tie-reroll, all members may have decimals but still be identical (e.g. 20.16 vs 20.16).
    //         In this case ALL members of the exact-value group must reroll again.
    const currentTieIds = new Set();
    for (const [base, ids] of initGroups) {
      if (ids.length < 2) continue;
      const needReroll = ids.filter(id => {
        const c = this.combat.combatants.get(id);
        return c && Number.isInteger(c.initiative);
      });
      if (needReroll.length > 0) {
        // Case 1: at least one integer initiative — only integers need to reroll
        for (const id of needReroll) currentTieIds.add(id);
      } else {
        // Case 2: all have decimals — check if any exact duplicate values exist within the group
        const exactGroups = new Map();
        for (const id of ids) {
          const c = this.combat.combatants.get(id);
          if (!c) continue;
          const val = c.initiative;
          if (!exactGroups.has(val)) exactGroups.set(val, []);
          exactGroups.get(val).push(id);
        }
        for (const [, exactIds] of exactGroups) {
          if (exactIds.length < 2) continue;
          // Exact tie after reroll — all must reroll again
          for (const id of exactIds) currentTieIds.add(id);
        }
      }
    }
    if (currentTieIds.size === 0) return;
    for (const id of currentTieIds) this._pendingTieRerolls.add(id);
    const allPending = Array.from(this._pendingTieRerolls);
    // Broadcast to clients so they show the orange indicator too
    const socketName = `module.${MODULE_ID}`;
    game.socket.emit(socketName, { action: 'syncTieRerolls', combatId: this.combat.id, ids: allPending, round: this.combat.round });
    this.refreshCards();
  }

  /**
   * Mark a combatant as having completed their tie reroll.
   * If all pending rerolls are done, clear the set and check for new ties.
   */
  markTieRerolled(combatantId) {
    this._pendingTieRerolls.delete(combatantId);

    // NOTE: We intentionally do NOT clean up "orphaned" combatants here.
    // If A and B were tied at 11, and A rerolls to 11.14, B should still be able
    // to reroll to try to beat A (e.g., get 11.15). B remains in the set until
    // they reroll themselves or the round changes.

    // Always broadcast current pending state to clients so they update immediately
    if (game.user.isGM) {
      const socketName = `module.${MODULE_ID}`;
      const remaining = Array.from(this._pendingTieRerolls);
      if (remaining.length === 0) {
        game.socket.emit(socketName, { action: 'clearTieRerolls', combatId: this.combat.id, round: this.combat.round });
        // CRITICAL FIX: Force complete combat state synchronization to all clients after ties are resolved
        // This prevents clients from getting stuck with "round not started" state during multiple tie scenarios
        setTimeout(() => {
          if (this.combat?.started) {
            game.socket.emit(socketName, { 
              action: 'forceCombatSync', 
              combatId: this.combat.id, 
              round: this.combat.round,
              turn: this.combat.turn,
              started: this.combat.started
            });
          }
        }, 100);
      } else {
        game.socket.emit(socketName, { action: 'syncTieRerolls', combatId: this.combat.id, ids: remaining, round: this.combat.round });
      }
      // Always refresh GM cards immediately so the rerolled combatant's border/icon updates
      this.refreshCards();
    }

    if (this._pendingTieRerolls.size === 0) {
      // All tied combatants have rerolled — check for new ties
      setTimeout(() => {
        this.detectTies();
        // Always refresh cards on GM side so yellow borders clear even when no new ties are found
        this.refreshCards();
        // Always try to fix turn after all pending rerolls are done (individual modes only, GM only)
        // _fixTurnToHighestInit() internally checks for pending ties and duplicates
        if (game.user.isGM && (this.initiativeMode === 'individual' || this.initiativeMode === 'individualChecklist' || this.initiativeMode === 'simpleIndividual')) {
          const initiatives = this.combat.combatants.map(c => c.initiative).filter(i => i != null);
          const allRolled = initiatives.length === this.combat.combatants.size;
          if (allRolled) {
            // Extra defer: Foundry re-sorts combat.turns after each initiative update, wait for it to settle
            const roundAtSchedule = this.combat.round;
            setTimeout(() => {
              if (this.combat?.round !== roundAtSchedule) return;
              this._fixTurnToHighestInit();
            }, 400);
          }
        }
      }, 100);
    }
  }

  /**
   * Check if a combatant is pending a tie reroll.
   */
  isPendingTieReroll(combatantId) {
    return this._pendingTieRerolls.has(combatantId);
  }

  _hasInitiativeRolled() {
    return this.combat.combatants.some(c => c.initiative != null);
  }

  _allInitiativeRolled() {
    return this.combat.combatants.every(c => c.initiative != null);
  }

  /**
   * True if there are combatants marked as waiting for the current round
   * who still need to roll initiative (for next round's ordering).
   */
  _hasWaitingNewcomersNeedingInit() {
    return this.combat.combatants.some(c =>
      c.getFlag('fantastic-depths-combat-carousel', 'waitingForRound') && c.initiative == null
    );
  }

  _hasUnselectedActions() {
    // In simpleIndividual/individual mode: no actions to select, always return false
    if (this.initiativeMode === 'simpleIndividual' || this.initiativeMode === 'individual') return false;
    // _resetPendingIds: combatants whose action was reset this round but not yet re-chosen
    return this.combat.combatants.some(c => {
      if (!c.actor) return false;
      if (c.getFlag('fantastic-depths-combat-carousel', 'choseNothing')) return false;
      if (this._resetPendingIds?.has(c.id)) return true;
      const action = c.actor.system?.combat?.declaredAction;
      return !action || action === 'nothing';
    });
  }

  _hasNPCUnselectedActions() {
    // In simpleIndividual/individual mode: no actions to select, always return false
    if (this.initiativeMode === 'simpleIndividual' || this.initiativeMode === 'individual') return false;
    return this.combat.combatants.some(c => {
      if (!c.actor) return false;
      if (c.token?.disposition !== CONST.TOKEN_DISPOSITIONS.HOSTILE) return false;
      if (c.getFlag('fantastic-depths-combat-carousel', 'choseNothing')) return false;
      if (this._resetPendingIds?.has(c.id)) return true;
      const action = c.actor.system?.combat?.declaredAction;
      return !action || action === 'nothing';
    });
  }

  _getFriendlyCombatants() {
    return this.combat.combatants.filter(c =>
      c.token?.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY
    );
  }

  _hasPlayerUnselectedActions() {
    // In simpleIndividual/individual mode: no actions to select, always return false
    if (this.initiativeMode === 'simpleIndividual' || this.initiativeMode === 'individual') return false;
    const friendlies = this._getFriendlyCombatants();
    const blocking = [];
    const result = friendlies.some(c => {
      if (!c.actor) return false;
      if (c.getFlag('fantastic-depths-combat-carousel', 'choseNothing')) return false;
      if (this._resetPendingIds?.has(c.id)) return true;
      const action = c.actor.system?.combat?.declaredAction;
      // Exclude combatants waiting for next round - their "nothing" action shouldn't block the carousel
      if (c.getFlag('fantastic-depths-combat-carousel', 'waitingForRound')) return false;
      const isBlocking = !action || action === 'nothing';
      if (isBlocking) {
        blocking.push(`${c.name} (${c.id}) action=${action} waiting=${c.getFlag('fantastic-depths-combat-carousel', 'waitingForRound')}`);
      }
      return isBlocking;
    });
    console.log(`FDCC | _hasPlayerUnselectedActions | result=${result} | friendlies=${friendlies.length} | waiting=${this.combat.combatants.filter(c => c.getFlag('fantastic-depths-combat-carousel', 'waitingForRound')).length}`);
    if (result) {
      console.log(`FDCC | _hasPlayerUnselectedActions | BLOCKING: ${blocking.join(', ')}`);
    }
    return result;
  }

  _hasPlayerInitiativeRolled() {
    return this.combat.combatants.some(c => {
      if (!c.actor) return false;
      if (!c.actor.hasPlayerOwner) return false;
      return c.initiative != null;
    });
  }

  async _rollNPCInitiative() {
    // Safety guard: block rolling initiative in hold mode from round 2+
    let nextRound = 'reset';
    try { nextRound = game.settings.get(game.system.id, 'nextRound') ?? 'reset'; } catch(e) {}
    if (nextRound === 'hold' && this.combat?.round > 1) {
      return;
    }
    const npcIds = this.combat.combatants
      .filter(c => c.token?.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE && c.initiative == null)
      .map(c => c.id);
    if (npcIds.length === 0) return;
    
    // CRITICAL FIX: Group modes should NOT include dexterity modifier
    if (this.isGroupMode) {
      // For group mode, roll initiative for hostile group only
      const formula = '1d6';
      const roll = new Roll(formula);
      await roll.evaluate();
      const result = roll.total;
      
      // Show DSN 3D dice for NPC group roll
      if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true);
      
      _log(`🎲 GROUP NPC | rolled ${result} for ${npcIds.length} hostile combatants`);
      
      // Send chat message for Enemies group roll
      await this._sendInitiativeChatMessage('🎲 Iniziativa Nemici', result, npcIds.length);
      
      const updates = npcIds.map(id => ({
        _id: id,
        initiative: result
      }));
      
      await this.combat.updateEmbeddedDocuments('Combatant', updates);
    } else {
      // Individual mode: roll each NPC separately with DSN
      const formula = game.settings.get(game.system.id, 'initiativeFormula') || '1d6';
      const rolls = [];
      
      for (const id of npcIds) {
        const combatant = this.combat.combatants.get(id);
        if (!combatant) continue;
        
        const actor = combatant.actor;
        const rollData = actor?.getRollData() ?? {};
        const dexMod = actor?.system?.abilities?.dex?.mod ?? 0;
        const initMod = actor?.system?.mod?.initiative ?? 0;
        rollData.mod = dexMod + initMod;
        
        const roll = new Roll(formula, rollData);
        await roll.evaluate();
        
        // Show DSN 3D dice for NPC individual roll
        if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true);
        await this._sendInitiativeChatMessage(combatant.name, roll.total, 1);
        
        rolls.push({ id, value: roll.total });
      }
      
      await Promise.all(rolls.map(r => this.combat.combatants.get(r.id)?.update({ initiative: r.value })));
    }
    
    setTimeout(() => this._fixTurnToHighestInit(), 300);
  }

  async _rollAllIndividual() {
    // Roll PCs first, then NPCs, with controlled chat messages
    await this._rollPlayerInitiative();
    await this._rollNPCInitiative();
  }

  async _rollPlayerInitiative() {
    // Safety guard: block rolling initiative in hold mode from round 2+
    let nextRound = 'reset';
    try { nextRound = game.settings.get(game.system.id, 'nextRound') ?? 'reset'; } catch(e) {}
    if (nextRound === 'hold' && this.combat?.round > 1) {
      return;
    }
    const formula = game.settings.get(game.system.id, 'initiativeFormula') || '1d6';
    if (this.isGroupMode) {
      // Group mode: all FRIENDLY combatants share one roll
      const friendlyIds = this._getFriendlyCombatants()
        .filter(c => c.initiative == null)
        .map(c => c.id);
      if (friendlyIds.length === 0) return;
      // CRITICAL FIX: Group mode should NOT include dexterity modifier
      const roll = new Roll('1d6');
      await roll.evaluate();
      
      // Show DSN 3D dice for Party group roll
      if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true);
      
      // Send chat message for Party group roll
      await this._sendInitiativeChatMessage('🎲 Iniziativa Party', roll.total, friendlyIds.length);
      
      // Update own combatant directly, delegate others to GM via socket
      const myIds = friendlyIds.filter(id => {
        const c = this.combat.combatants.get(id);
        return c?.actor?.isOwner;
      });
      const otherIds = friendlyIds.filter(id => !myIds.includes(id));
      if (myIds.length > 0) {
        await Promise.all(myIds.map(id => this.combat.combatants.get(id)?.update({ initiative: roll.total })));
      }
      if (otherIds.length > 0) {
        const payload = {
          action: 'setGroupInitiative',
          combatId: this.combat.id,
          ids: otherIds,
          value: roll.total
        };
          game.socket.emit(`module.fantastic-depths-combat-carousel`, payload);
      }
    } else {
      // Individual mode: each PC owned by a player rolls separately
      const pcIds = this.combat.combatants
        .filter(c => c.actor?.hasPlayerOwner && c.initiative == null)
        .map(c => c.id);
      if (pcIds.length === 0) return;
      const rolls = [];
      for (const id of pcIds) {
        const combatant = this.combat.combatants.get(id);
        if (!combatant) continue;
        const actor = combatant.actor;
        const rollData = actor?.getRollData() ?? {};
        const dexMod = actor?.system?.abilities?.dex?.mod ?? 0;
        const initMod = actor?.system?.mod?.initiative ?? 0;
        rollData.mod = dexMod + initMod;
        const roll = new Roll(formula, rollData);
        await roll.evaluate();
        if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true);
        await this._sendInitiativeChatMessage(combatant.name, roll.total, 1);
        rolls.push({ id, value: roll.total });
      }
      await Promise.all(rolls.map(r => this.combat.combatants.get(r.id)?.update({ initiative: r.value })));
      setTimeout(() => this._fixTurnToHighestInit(), 300);
    }
    this._updateRollPCsButton();
  }

  _updateRollPCsButton() {
    const btn = this.element?.querySelector('[data-action="roll-pcs"]');
    if (!btn) return;
    // In hold mode from round 2+: block rolling initiative (keep previous round values)
    // Round 0/1: allow normal initiative rolling
    let nextRound = 'reset';
    try { nextRound = game.settings.get(game.system.id, 'nextRound') ?? 'reset'; } catch(e) {}
    const hasWaitingPCWithoutInit = this.combat.combatants.some(c =>
      c.actor?.hasPlayerOwner &&
      c.getFlag('fantastic-depths-combat-carousel', 'waitingForRound') &&
      c.initiative == null
    );
    if (nextRound === 'hold' && this.combat?.round > 1 && !hasWaitingPCWithoutInit) {
      btn.disabled = true;
      btn.classList.remove('roll-pcs-ready');
      return;
    }
    const allActionsChosen = !this._hasPlayerUnselectedActions();
    // Always check player initiative specifically — NPC init from previous round must not block roll-pcs.
    // If we are in action-selection phase (_resetPendingIds not empty), treat initiative as not yet rolled
    // (old initiative values from previous round are still in DB but shouldn't block the button).
    // Newly joined combatants that are waiting for the current round may still roll for next round.
    const anyPending = (this._resetPendingIds?.size ?? 0) > 0;
    const initiativeRolled = !anyPending && !hasWaitingPCWithoutInit && this._hasPlayerInitiativeRolled();
    
    // CRITICAL FIX: In group mode, block roll-pc after round 0 (only allow in first round)
    const isGroupModeAfterRound0 = this.isGroupMode && this.combat?.round > 0;
    
    console.log(`FDCC | _updateRollPCsButton | allActionsChosen=${allActionsChosen} initiativeRolled=${initiativeRolled} isGroupModeAfterRound0=${isGroupModeAfterRound0}`);
    
    if (initiativeRolled || isGroupModeAfterRound0) {
      btn.disabled = true;
      btn.classList.remove('roll-pcs-ready');
    } else if (allActionsChosen) {
      btn.disabled = false;
      btn.classList.add('roll-pcs-ready');
    } else {
      btn.disabled = true;
      btn.classList.remove('roll-pcs-ready');
    }
  }

  _updateGMRollButtons() {
    if (!game.user.isGM) return;
    const npcBtn = this.element?.querySelector('[data-action="roll-npc"]');
    const allBtn = this.element?.querySelector('[data-action="roll-all"]');
    const gmPcsBtn = this.element?.querySelector('.carousel-controls.right [data-action="roll-pcs"]');
    // In hold mode from round 2+: block rolling initiative - no glow on buttons
    // Round 0/1: allow normal initiative rolling
    let nextRound = 'reset';
    try { nextRound = game.settings.get(game.system.id, 'nextRound') ?? 'reset'; } catch(e) {}
    if (nextRound === 'hold' && this.combat?.round > 1) {
      if (npcBtn) npcBtn.classList.remove('roll-npc-ready');
      if (allBtn) allBtn.classList.remove('roll-all-ready');
      if (gmPcsBtn) {
        gmPcsBtn.disabled = true;
        gmPcsBtn.classList.remove('roll-pcs-ready');
      }
      return;
    }
    // For simpleIndividual/individual modes: no actions needed, always consider "ready"
    const isSimpleMode = this.initiativeMode === 'individual' || this.initiativeMode === 'simpleIndividual';
    const allActionsChosen = isSimpleMode ? true : !this._hasUnselectedActions();
    const anyPending = this._resetPendingIds?.size > 0;
    const npcReady = !anyPending && (isSimpleMode || !this._hasNPCUnselectedActions()) && !this._hasNPCInitiativeRolled();
    if (npcBtn) npcBtn.classList.toggle('roll-npc-ready', npcReady);
    // In group mode: when all actions chosen + NPC have init but PCs don't → show roll-pcs instead of roll-all
    if (this.isGroupMode && gmPcsBtn) {
      const npcHaveInit = this.combat.combatants.some(c =>
        c.token?.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE && c.initiative != null
      );
      const pcsNeedInit = this._getFriendlyCombatants().some(c => c.initiative == null);
      const showPcsSwap = allActionsChosen && npcHaveInit && pcsNeedInit;
      // Swap visibility
      if (allBtn) allBtn.style.display = showPcsSwap ? 'none' : '';
      gmPcsBtn.style.display = showPcsSwap ? '' : 'none';
      if (showPcsSwap) {
        gmPcsBtn.disabled = false;
        gmPcsBtn.classList.add('roll-pcs-ready');
      } else {
        gmPcsBtn.disabled = true;
        gmPcsBtn.classList.remove('roll-pcs-ready');
      }
      // roll-all glow when all actions chosen and no init rolled yet (and not in pcs-swap state)
      const allReady = !anyPending && allActionsChosen && !this._allInitiativeRolled() && !showPcsSwap;
      if (allBtn) allBtn.classList.toggle('roll-all-ready', allReady);
    } else {
      // Non-group mode: normal roll-all glow
      // In individual modes: also block if there are tied initiatives pending resolution
      const initiatives = this.combat.combatants.map(c => c.initiative).filter(i => i != null);
      const hasDuplicates = initiatives.length !== new Set(initiatives).size;
      const hasPendingTie = this._pendingTieRerolls?.size > 0;
      const tieBlocked = (this.initiativeMode === 'individual' || this.initiativeMode === 'individualChecklist' || this.initiativeMode === 'simpleIndividual') && (hasDuplicates || hasPendingTie);
      // Newly joined combatants waiting for the current round may still roll initiative for next round,
      // so they don't count as "missing" for the roll-all glow.
      const allRelevantRolled = this.combat.combatants.every(c =>
        c.initiative != null || c.getFlag('fantastic-depths-combat-carousel', 'waitingForRound')
      );
      const allReady = !anyPending && !tieBlocked && (isSimpleMode || allActionsChosen) && !allRelevantRolled;
      if (allBtn) allBtn.classList.toggle('roll-all-ready', allReady);
      if (npcBtn) npcBtn.classList.toggle('roll-npc-ready', !tieBlocked && npcReady);
    }
  }

  _hasNPCInitiativeRolled() {
    return this.combat.combatants.some(c =>
      c.token?.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE && c.initiative != null
    );
  }

  _updateStartCombatButton() {
    const btn = this.element?.querySelector('[data-action="start-combat"]');
    if (!btn) return;
    const allActionsChosen = !this._hasUnselectedActions();
    const allInitiative = this._allInitiativeRolled();
    const hasTies = (this._pendingTieRerolls?.size ?? 0) > 0;
    const ready = allActionsChosen && allInitiative && !hasTies && !this.combat.started;
    if (ready) {
      btn.disabled = false;
      btn.classList.add('start-combat-ready');
    } else if (hasTies) {
      // Keep clickable so the ties warning can be shown, but not visually ready
      btn.disabled = false;
      btn.classList.remove('start-combat-ready');
    } else {
      btn.disabled = true;
      btn.classList.remove('start-combat-ready');
    }
  }

  _nextTurn() {
    if (!['individual', 'individualChecklist', 'simpleIndividual', 'group', 'advancedGroup'].includes(this.initiativeMode)) {
      return this.combat.nextTurn();
    }
    if (this.isTwoPhaseMode) {
      // In advancedGroup (2-phase) mode, each combatant appears twice in combat.turns.
      // Move through every combat.turn entry instead of jumping to the next round.
      // Skip entries for combatants waiting for the current round.
      let nextTurn = this.combat.turn + 1;
      while (nextTurn < this.combat.turns.length && this.combat.turns[nextTurn].getFlag('fantastic-depths-combat-carousel', 'waitingForRound')) {
        nextTurn++;
      }
      if (nextTurn >= this.combat.turns.length) {
        return this.combat.nextRound();
      }
      return this.combat.update({ turn: nextTurn });
    }
    if (this.isGroupMode) {
      const sorted = this.sortedCombatants;
      let nextIdx = this._sortedTurnIdx + 1;
      while (nextIdx < sorted.length && sorted[nextIdx].getFlag('fantastic-depths-combat-carousel', 'waitingForRound')) {
        nextIdx++;
      }
      if (nextIdx >= sorted.length) {
        this._sortedTurnIdx = 0;
        return this.combat.nextRound();
      }
      this._sortedTurnIdx = nextIdx;
      this.refreshCards();
      console.log(`FDCC | nextTurn() | about to call _playTurnSound(${nextIdx})`);
      this._playTurnSound(nextIdx);
      this._selectActiveToken();
      // Align Foundry's combat.turn with the carousel so Foundry selects/pans the token natively
      const activeTurnIdx = this.combat.turns.findIndex(c => c.id === sorted[nextIdx].id);
      if (activeTurnIdx >= 0) this.combat.update({ turn: activeTurnIdx });
      if (game.user.isGM) {
        this.combat.setFlag('fantastic-depths-combat-carousel', 'sortedTurnIdx', nextIdx);
      } else {
        game.socket.emit(`module.fantastic-depths-combat-carousel`, {
          action: 'setSortedTurnIdx',
          combatId: this.combat.id,
          value: nextIdx
        });
      }
      return;
    }
    // individualChecklist: use combat.combatant
    const sorted = this.sortedCombatants;
    const currentId = this.combat.combatant?.id;
    const currentIdx = sorted.findIndex(c => c.id === currentId);
    let nextIdx = currentIdx + 1;
    while (nextIdx < sorted.length && sorted[nextIdx].getFlag('fantastic-depths-combat-carousel', 'waitingForRound')) {
      nextIdx++;
    }
    if (nextIdx >= sorted.length) return this.combat.nextRound();
    const nextCombatant = sorted[nextIdx];
    const turnIdx = this.combat.turns.findIndex(c => c.id === nextCombatant.id);
    if (turnIdx >= 0) this.combat.update({ turn: turnIdx });
  }

  _previousTurn() {
    if (!['individual', 'individualChecklist', 'simpleIndividual', 'group', 'advancedGroup'].includes(this.initiativeMode)) {
      return this.combat.previousTurn();
    }
    if (this.isTwoPhaseMode) {
      // Skip entries for combatants waiting for the current round.
      let prevTurn = this.combat.turn - 1;
      while (prevTurn >= 0 && this.combat.turns[prevTurn].getFlag('fantastic-depths-combat-carousel', 'waitingForRound')) {
        prevTurn--;
      }
      if (prevTurn < 0) {
        return this.combat.previousRound();
      }
      return this.combat.update({ turn: prevTurn });
    }
    if (this.isGroupMode) {
      const sorted = this.sortedCombatants;
      let prevIdx = this._sortedTurnIdx - 1;
      while (prevIdx >= 0 && sorted[prevIdx].getFlag('fantastic-depths-combat-carousel', 'waitingForRound')) {
        prevIdx--;
      }
      if (prevIdx < 0) {
        // Going to previous round: set to last combatant of that round
        this._sortedTurnIdx = Math.max(0, sorted.length - 1);
        return this.combat.previousRound();
      }
      this._sortedTurnIdx = prevIdx;
      this.refreshCards();
      this._selectActiveToken();
      // Align Foundry's combat.turn with the carousel
      const activeTurnIdx = this.combat.turns.findIndex(c => c.id === sorted[this._sortedTurnIdx].id);
      if (activeTurnIdx >= 0) this.combat.update({ turn: activeTurnIdx });
      if (game.user.isGM) {
        this.combat.setFlag('fantastic-depths-combat-carousel', 'sortedTurnIdx', this._sortedTurnIdx);
      } else {
        game.socket.emit(`module.fantastic-depths-combat-carousel`, {
          action: 'setSortedTurnIdx',
          combatId: this.combat.id,
          value: this._sortedTurnIdx
        });
      }
      return;
    }
    // individualChecklist
    const sorted = this.sortedCombatants;
    const currentId = this.combat.combatant?.id;
    const currentIdx = sorted.findIndex(c => c.id === currentId);
    let prevIdx = currentIdx - 1;
    while (prevIdx >= 0 && sorted[prevIdx].getFlag('fantastic-depths-combat-carousel', 'waitingForRound')) {
      prevIdx--;
    }
    if (prevIdx < 0) return this.combat.previousRound();
    const prevCombatant = sorted[prevIdx];
    const turnIdx = this.combat.turns.findIndex(c => c.id === prevCombatant.id);
    if (turnIdx >= 0) this.combat.update({ turn: turnIdx });
  }

  async _autoRollIfReady() {
    if (!game.user.isGM) return;
    if (!this.isGroupMode && this.initiativeMode !== 'individual' && this.initiativeMode !== 'individualChecklist' && this.initiativeMode !== 'simpleIndividual') return;
    if (!this.combat?.started) return;
    if (this._autoRolling) return;
    if (this._initiativeClearing) return;
    const currentRound = this.combat.round;
    if (this._autoRolledRound === currentRound) return;
    let nextRound = 'reset';
    try { nextRound = game.settings.get(game.system.id, 'nextRound') ?? 'reset'; } catch(e) {}
    // In hold mode from round 2+: never auto-roll initiative (initiative already rolled in round 1)
    if (nextRound === 'hold' && this.combat?.round > 1) return;
    if (nextRound !== 'reroll') return;
    // CRITICAL FIX: Allow auto-roll in reroll mode for new rounds, but block mid-round joins
    // Don't auto-roll when a single combatant joins mid-round and rolls initiative
    // But DO allow auto-roll at the start of new rounds in reroll mode (even if turn > 0 from previous round)
    if (this.isIndividualMode) {
      // Check if this is a new round start (initiative just cleared) vs mid-round combatant join.
      // A new round start means EVERY combatant has null initiative (initiatives were cleared).
      // A mid-round join means only the newly added combatant(s) have null initiative.
      // This applies regardless of combat.turn value (turn 0 is also a valid mid-round state).
      const hasInitiativeCleared = this.combat.combatants.every(c => c.initiative == null);
      if (!hasInitiativeCleared) {
        _log(`_autoRollIfReady | skipping auto-roll - individual mode (mid-round join, not all initiatives cleared)`);
        return;
      } else {
        _log(`_autoRollIfReady | allowing auto-roll - individual mode (all initiatives cleared)`);
      }
    }
    // In group mode FaDe assigns one initiative per group (not per combatant), so use _hasInitiativeRolled
    const initiativeRolled = this.isGroupMode ? this._hasInitiativeRolled() : this._allInitiativeRolled();
    if (initiativeRolled) return;
    if (this._hasUnselectedActions()) return;
    this._autoRolling = true;
    this._autoRolledRound = currentRound;
    _log(`🎲 AUTO-ROLL | round=${currentRound} | mode=${this.initiativeMode}`);
    
    // CRITICAL FIX: Group modes should NOT include dexterity modifier
    if (this.isGroupMode) {
      await this._rollGroupInitiative();
    } else {
      await this._rollAllIndividual();
    }
    
    _log('🎲 INITIATIVE RESULTS |', Array.from(this.combat.combatants).map(c => `${c.name}: ${c.initiative}`).join(', '));
    // Slow weapon rule (individual mode): after rollAll, override initiative for slow combatants.
    // Slow combatants go last with score 0 + (their roll / 100).
    if (this.initiativeMode === 'individual' || this.initiativeMode === 'individualChecklist') {
      const slowUpdates = [];
      for (const combatant of this.combat.combatants) {
        const items = combatant.actor?.items;
        if (!items) continue;
        const hasSlowEquipped = items.some(i =>
          i.type === 'weapon' && i.system?.equipped === true && i.system?.isSlow === true
        );
        if (!hasSlowEquipped) continue;
        const rawInit = combatant.initiative;
        if (rawInit == null) continue;
        // Only correct if the value is currently a full integer (i.e. rollAll wrote it without slow rule)
        if (!Number.isInteger(rawInit)) continue;
        const slowInit = Math.round(rawInit / 100 * 100) / 100;
        slowUpdates.push(combatant.update({ initiative: slowInit }));
      }
      if (slowUpdates.length > 0) await Promise.all(slowUpdates);
    }
    // Broadcast to clients that pending IDs are cleared — roll is done, actions are locked in
    this._resetPendingIds?.clear();
    const socketName = `module.${MODULE_ID}`;
    game.socket.emit(socketName, { action: 'clearAllPendingIds', combatId: this.combat.id });
    this.refreshCards();
    this._autoRolling = false;
    // Fix turn order after rollAll: FaDe's _activateCombatant may set combat.turn to the wrong combatant.
    // Delay to let FaDe finish, then correct to highest initiative.
    if (this.initiativeMode === 'individual' || this.initiativeMode === 'individualChecklist' || this.initiativeMode === 'simpleIndividual') {
      setTimeout(() => {
        const initiatives = this.combat.combatants.map(c => c.initiative).filter(i => i != null);
        const allRolled = initiatives.length === this.combat.combatants.size;
        const integerInits = initiatives.filter(i => Number.isInteger(i));
        const hasDuplicates = integerInits.length !== new Set(integerInits).size;
        if (allRolled && !hasDuplicates && this._pendingTieRerolls.size === 0) {
          // If any combatant joined mid-round and is waiting for the next round, do not reset the turn here.
          const hasWaiting = this.combat.combatants.some(c =>
            c.getFlag('fantastic-depths-combat-carousel', 'waitingForRound')
          );
          if (hasWaiting) { _log(`_autoRollIfReady | post-rollAll fix skipped — waitingForRound present`); return; }
          // Use highest raw initiative, NOT sortedCombatants[0] which applies action-phase sort
          const first = Array.from(this.combat.combatants).reduce((best, c) =>
            (c.initiative != null && (best == null || c.initiative > best.initiative)) ? c : best, null);
          if (first) {
            const turnIdx = this.combat.turns.findIndex(c => c.id === first.id);
            _log(`_autoRollIfReady | post-rollAll fix | first=${first.name} turnIdx=${turnIdx} currentTurn=${this.combat.turn}`);
            if (turnIdx >= 0 && turnIdx !== this.combat.turn) this.combat.update({ turn: turnIdx });
          }
        }
      }, 300);
    }
  }

  _fixTurnToHighestInit() {
    if (!game.user.isGM) return;
    if (this.initiativeMode !== 'individual' && this.initiativeMode !== 'individualChecklist' && this.initiativeMode !== 'simpleIndividual') return;
    if (!this.combat.started) return;
    if (this._roundChanging) { _log('_fixTurnToHighestInit | skipped — round changing'); return; }
    const initiatives = this.combat.combatants.map(c => c.initiative).filter(i => i != null);
    if (initiatives.length !== this.combat.combatants.size) return;
    // Only consider integer initiatives for duplicate detection.
    // Slow-weapon combatants have decimal initiatives (0.XX) — identical decimals are not real ties
    // and must not block the turn fix.
    const integerInits = initiatives.filter(i => Number.isInteger(i));
    const hasDuplicates = integerInits.length !== new Set(integerInits).size;
    if (hasDuplicates) return;
    if (this._pendingTieRerolls?.size > 0) return;
    // If any combatant is waiting for the current round (newly joined mid-round),
    // do not reset the turn — the active combatant must stay where it is.
    const hasWaiting = this.combat.combatants.some(c =>
      c.getFlag('fantastic-depths-combat-carousel', 'waitingForRound')
    );
    if (hasWaiting) { _log('_fixTurnToHighestInit | skipped — waitingForRound combatants present'); return; }
    // Use the first entry in combat.turns — FaDe already sorts by action phase then initiative,
    // so combat.turns[0] is the combatant that should act first according to the Combat Sequence.
    const first = this.combat.turns[0];
    if (!first) return;
    _log(`_fixTurnToHighestInit | first=${first.name} (${first.initiative}) turnIdx=0 currentTurn=${this.combat.turn} | turns order: ${this.combat.turns.map(c => c.name + ':' + c.initiative).join(', ')}`);
    // Always update turn if the current active combatant is not the first in combat.turns
    const currentActiveId = this.combat.combatant?.id;
    if (first.id !== currentActiveId && this.combat.turn !== 0) {
      this.combat.update({ turn: 0 });
    }
  }

  _playTurnSound(combatantIdx) {
    // DEBUG: Force log to verify function is being called
    console.log(`FDCC | _playTurnSound | CALLED - user=${game.user.name} isGM=${game.user.isGM}`);
    
    // CRITICAL FIX: Disable turn sounds for GM - only players should hear their own turn sounds
    if (game.user.isGM) {
      console.log(`FDCC | _playTurnSound | BLOCKED - GM should not hear turn sounds`);
      return;
    }
    const activeCombatant = this.sortedCombatants?.[combatantIdx ?? this._sortedTurnIdx];
    if (!activeCombatant?.isOwner) return;
    
    // CRITICAL FIX: Suppress FaDe's internal turn sounds, then play our controlled sound
    const orig = game.audio.play.bind(game.audio);
    game.audio.play = () => {};
    setTimeout(() => { game.audio.play = orig; }, 500);
    
    console.log(`FDCC | _playTurnSound | PLAYING - ${activeCombatant.name} turn sound for owner`);
    try { orig('sounds/combat/epic-turn-1hit.ogg', { volume: 0.8 }); } catch(e) {}
  }

  async _rollGroupInitiative() {
    _log('🎲 GROUP INITIATIVE | Rolling without dexterity modifier');
    
    // Group initiative: 1d6 per group, no dexterity modifier
    const formula = '1d6';
    const updates = [];
    
    // Group by disposition (friendly/hostile/neutral)
    const groups = {};
    for (const combatant of this.combat.combatants) {
      const disposition = combatant.token?.disposition ?? CONST.TOKEN_DISPOSITIONS.NEUTRAL;
      if (!groups[disposition]) groups[disposition] = [];
      groups[disposition].push(combatant);
    }
    
    // Roll once per group
    for (const [disposition, combatants] of Object.entries(groups)) {
      const roll = new Roll(formula);
      await roll.evaluate();
      const result = roll.total;
      
      // Show DSN 3D dice for group roll
      if (game.dice3d) await game.dice3d.showForRoll(roll, game.user, true);
      
      _log(`🎲 GROUP ${disposition} | rolled ${result} for ${combatants.length} combatants`);
      
      // Send chat message for this group
      let groupName = 'Group';
      if (disposition == String(CONST.TOKEN_DISPOSITIONS.FRIENDLY)) {
        groupName = game.i18n.localize('FDCC.InitiativeChat.Party');
      } else if (disposition == String(CONST.TOKEN_DISPOSITIONS.HOSTILE)) {
        groupName = game.i18n.localize('FDCC.InitiativeChat.Enemies');
      } else if (disposition == String(CONST.TOKEN_DISPOSITIONS.NEUTRAL)) {
        groupName = game.i18n.localize('FDCC.InitiativeChat.Neutral');
      }
      
      await this._sendInitiativeChatMessage(groupName, result, combatants.length);
      
      // Apply same initiative to all combatants in this group
      for (const combatant of combatants) {
        updates.push({
          _id: combatant.id,
          initiative: result
        });
      }
    }
    
    // Update all combatants at once
    await this.combat.updateEmbeddedDocuments('Combatant', updates);
    _log(`🎲 GROUP INITIATIVE | Complete - updated ${updates.length} combatants`);
  }

  _playRoundSound() {
    if (game.user.isGM) return;
    try { game.audio.play('sounds/combat/epic-turn-2hit.ogg', { volume: 0.8 }); } catch(e) {}
  }

  async _sendInitiativeChatMessage(title, result, count) {
    try {
      // Safety check: verifica che le dipendenze esistano
      if (!game?.user || !ChatMessage) {
        console.warn('FDCC | Chat dependencies not available, skipping message');
        return;
      }
      
      // Formato pulito: "Iniziativa - Party\n5" o "Iniziativa - Oz\n5"
      const cleanTitle = title.replace(/^🎲\s*/, '');
      const initiativeLabel = game.i18n.localize('FDCC.InitiativeChat.Initiative');
      const displayTitle = `${initiativeLabel} - ${cleanTitle}`;
      
      const chatData = {
        user: game.user.id,
        speaker: { alias: displayTitle },
        content: `<div style="text-align:center;font-size:1.5em;font-weight:bold;">${result}</div>`
      };
      
      // Aggiungi type solo se esiste un valore valido
      if (typeof CONST !== 'undefined' && CONST.CHAT_MESSAGE_TYPES) {
        const validType = CONST.CHAT_MESSAGE_TYPES.ROLL || 
                         CONST.CHAT_MESSAGE_TYPES.OOC || 
                         CONST.CHAT_MESSAGE_TYPES.OTHER;
        if (validType && typeof validType === 'number') {
          chatData.type = validType;
        }
      }
      
      await ChatMessage.create(chatData);
      
    } catch (error) {
      // NON bloccare il funzionamento del modulo se la chat fallisce
      console.warn('FDCC | Chat message failed, but continuing normally:', error.message);
    }
  }

  
  _playStartSound() {
    if (game.user.isGM) return;
    try { game.audio.play('sounds/combat/epic-start-horn.ogg', { volume: 0.8 }); } catch(e) {}
  }

  _setHooks() {
    this._removeHooks();

    // DEBUG: Track who is sending action updates + BLOCK FaDe's auto-attack during round change
    this._hooks.push({ name: 'preUpdateActor', id: Hooks.on('preUpdateActor', (actor, changes, options, userId) => {
      const newAction = changes?.system?.combat?.declaredAction;
      if (newAction === undefined) return;
      const currentAction = actor.system?.combat?.declaredAction;
      const user = game.users.get(userId);
      const combatant = this.combat?.combatants.find(c => c.actor?.id === actor.id);
      const inPending = combatant ? this._resetPendingIds?.has(combatant.id) : 'N/A';
      
      _log(`preUpdateActor | ${actor.name} | newAction=${newAction} | currentAction=${currentAction} | from=${user?.name} | inPending=${inPending} | _roundChanging=${this._roundChanging}`);
      
      // BLOCK: When forcing re-selection, prevent FaDe from auto-setting attack/fire during round change
      if (forceActionReselect() && this._roundChanging && inPending === true && (newAction === 'attack' || newAction === 'fire')) {
        _warn(`preUpdateActor | BLOCKED | ${actor.name} | FaDe auto-${newAction} prevented during round change`);
        return false; // Block the update
      }
    }) });

    this._hooks.push({ name: 'updateActor', id: Hooks.on('updateActor', (actor, changes, options, userId) => {
      const action = changes?.system?.combat?.declaredAction;
      if (action === undefined) return;
      const combatant = this.combat?.combatants.find(c => c.actor?.id === actor.id);
      if (!combatant) return;
      // BLOCK: Prevent FaDe or other systems from restoring old actions during round change
      // This fixes the bug where Round 2 actions persist into Round 3
      // NOTE: Only block NON-GM updates (updates from players, not from the GM)
      const fromUser = game.users.get(userId);
      const isFromGM = fromUser?.isGM ?? false;
      if (this._roundChanging && action !== 'nothing' && this._resetPendingIds?.has(combatant.id) && !isFromGM) {
        _warn(`updateActor | BLOCKED | ${actor.name} | action=${action} | _roundChanging=true, inPending=true, isFromGM=false`);
        return; // Block this update - action will be reset to 'nothing' by GM
      }
      // Remove from pending set if present (only relevant mid-round after nextRound)
      // Note: _roundChanging is NOT checked here — if a player chooses an action, we process it immediately
      if (action && action !== 'nothing' && this._resetPendingIds?.has(combatant.id)) {
        this._resetPendingIds.delete(combatant.id);
        _log(`updateActor | ${actor.name} chose ${action} — removed from _resetPendingIds (${this._resetPendingIds.size} remaining)`);
      }
      // Always refresh so GM sees players' action changes immediately
      this.refreshCards();
      this._autoRollIfReady();
    }) });

    this._hooks.push({ name: 'updateCombatant', id: Hooks.on('updateCombatant', (combatant, changes) => {
      if (combatant.parent !== this.combat) return;
      // When initiative changes, the active combatant may have changed position or identity.
      // Re-apply the canvas selection after the batch of updates settles.
      if (changes?.initiative !== undefined) {
        if (this._initiativeChangeTimeout) clearTimeout(this._initiativeChangeTimeout);
          this._initiativeChangeTimeout = setTimeout(() => {
          this._initiativeChangeTimeout = null;
          const active = this.isGroupMode ? this.sortedCombatants?.[this._sortedTurnIdx] : this.combat.combatant;
          console.log(`FDCC | TOKEN DEBUG | initiative batch settled | active=${active?.name ?? '?'} | refreshing cards & re-selecting token`);
          // In group/advancedGroup, after initiative settles the turn must point to the top of the new order.
          // Otherwise the carousel/canvas may stay on a combatant from the previous turn.
          // However, if a combatant joined mid-round and is waiting for the next round, do NOT
          // reset the turn — the active combatant must stay where it is.
          const hasWaiting = this.combat.combatants.some(c =>
            c.getFlag('fantastic-depths-combat-carousel', 'waitingForRound')
          );
          if (this.isGroupMode && game.user.isGM && this.combat?.started && this.combat.turn !== 0 && !hasWaiting) {
            console.log(`FDCC | TOKEN DEBUG | initiative changed — forcing combat.turn=0 to match new order`);
            this.combat.update({ turn: 0 });
            return;
          } else if (hasWaiting) {
            // Mid-round join: keep the active card on the combatant that was active before the join,
            // even if combat.turns has re-sorted underneath. This prevents a flash onto the new entry.
            const preservedId = this._midRoundJoinActiveId;
            if (preservedId) {
              const preservedIdx = this.sortedCombatants.findIndex(c => c.id === preservedId);
              if (preservedIdx >= 0 && preservedIdx !== this._sortedTurnIdx) {
                this._sortedTurnIdx = preservedIdx;
              }
            }
            console.log(`FDCC | TOKEN DEBUG | initiative changed with waitingForRound — skipping auto token selection`);
          } else {
            this._selectActiveToken();
            this._guardTokenSelection(1000);
          }
          // Refresh only after _sortedTurnIdx has been corrected for mid-round joins.
          this.refreshCards();
          this._scrollToActive();
          this._updateRoundIndicator();
        }, 150);
      }
      // When choseNothing flag is set, remove from pending set
      if (!this._resetPendingIds?.size) return;
      const choseNothing = changes?.flags?.['fantastic-depths-combat-carousel']?.choseNothing;
      if (choseNothing === true) {
        this._resetPendingIds.delete(combatant.id);
        _log(`updateCombatant | ${combatant.name} chose Nothing — removed from _resetPendingIds (${this._resetPendingIds.size} remaining)`);
        this.refreshCards();
        this._autoRollIfReady();
      }
    }) });

    // DEBUG: Track token selection changes to diagnose race conditions with FaDe/other systems
    this._hooks.push({ name: 'controlToken', id: Hooks.on('controlToken', (token, controlled) => {
      if (!this.combat?.started) return;
      const active = this.isGroupMode ? this.sortedCombatants?.[this._sortedTurnIdx] : this.combat.combatant;
      const activeId = active?.token?.object?.id;
      const selected = canvas.tokens?.controlled?.map(t => `${t.name} (${t.id})`).join(', ') ?? 'none';
      console.log(`FDCC | TOKEN DEBUG | controlToken | token=${token.name} (${token.id}) | controlled=${controlled} | selected=[${selected}] | active=${active?.name ?? '?'} (${activeId ?? '?'}) | user=${game.user.name}`);
      // During a mid-round join, immediately reject selection of any token other than the
      // active one to prevent the canvas from flashing onto the newly added token.
      if (this._midRoundJoinActiveId && controlled && activeId && token.id !== activeId) {
        console.log(`FDCC | TOKEN DEBUG | controlToken | mid-round join guard — rejecting ${token.name}`);
        this._selectActiveToken();
        this._guardTokenSelection(2000);
      }
    }) });

    this._hooks.push({ name: 'updateCombat', id: Hooks.on('updateCombat', (combat, updates, options, userId) => {
      if (combat !== this.combat) return;
      // Sync sortedTurnIdx from GM's flag update (players receive this)
      const flagIdx = updates?.flags?.['fantastic-depths-combat-carousel']?.sortedTurnIdx;
      if (typeof flagIdx === 'number' && !game.user.isGM) {
        this._sortedTurnIdx = flagIdx;
        this.refreshCards();
        this._scrollToActive();
        console.log(`FDCC | updateCombat() | about to call _playTurnSound(${flagIdx}) - PLAYER ONLY`);
        this._playTurnSound(flagIdx);
        console.log(`FDCC | TOKEN DEBUG | calling _selectActiveToken from sortedTurnIdx sync`);
        this._selectActiveToken();
        this._guardTokenSelection(2000);
      }
      // Detect turn changes
      if ('turn' in updates) {
        // When a new round begins, Foundry may emit a transient turn=0 before the
        // initiatives are re-rolled. Skip it to avoid flashing the wrong combatant,
        // but do NOT return so the round-change block below still runs.
        const skipTurnChange = ('round' in updates) && updates.round > 1 && updates.turn === 0;
        if (!skipTurnChange) {
          const active = combat.combatant;
          _log(`↷ TURN CHANGE | round=${combat.round} turn=${updates.turn} | active=${active?.name ?? '?'} (init: ${active?.initiative ?? '?'})`);
          if (this.isGroupMode) {
            // Mirror the core tracker exactly: the active combatant is the source of truth.
            this._sortedTurnIdx = this._getSortedIdxForTurn(updates.turn);
            this.refreshCards();
            this._scrollToActive();
            this._updateRoundIndicator();
            console.log(`FDCC | updateCombat() | about to call _playTurnSound(${this._sortedTurnIdx}) - PLAYER ONLY`);
            this._playTurnSound(this._sortedTurnIdx);
          }
          console.log(`FDCC | TOKEN DEBUG | calling _selectActiveToken from turn change`);
          this._selectActiveToken();
          this._guardTokenSelection(2000);
        } else {
          console.log(`FDCC | TOKEN DEBUG | skipping transient turn=0 during round change`);
        }
      }
      // When combat starts (round 1), fix turn order for individual modes
      if ('round' in updates && updates.round === 1) {
        this._playStartSound();
        if (game.user.isGM && (this.initiativeMode === 'individual' || this.initiativeMode === 'individualChecklist' || this.initiativeMode === 'simpleIndividual')) {
          setTimeout(() => this._fixTurnToHighestInit(), 300);
        }
      }
      if ('round' in updates && updates.round > 1) {
        this._playRoundSound();
        let nextRound = 'reset';
        try { nextRound = game.settings.get(game.system.id, 'nextRound') ?? 'reset'; } catch(e) {}
        const requireReselect = forceActionReselect();
        _log(`══ ROUND ${updates.round} ══ | mode=${this.initiativeMode} | nextRound=${nextRound} | isGM=${game.user.isGM} | forceActionReselect=${requireReselect}`);
        this._pendingTieRerolls.clear();
        this._npcActions.clear(); // Clear shadow state from previous round
        this._autoRolledRound = null;
        this._autoRolling = false;
        this._initiativeClearing = false;
        if (requireReselect) this._roundChanging = true;
        
        // Clear waiting flags for all combatants at round start
        if (game.user.isGM) {
          for (const combatant of this.combat.combatants) {
            combatant.unsetFlag('fantastic-depths-combat-carousel', 'waitingForRound');
          }
        }
        // _roundChanging will be cleared by the deferred setTimeout below (non-GM) or by main.mjs patch (GM)
        // Non-GM clients populate _resetPendingIds here (GM already did it in main.mjs nextRound patch)
        if (requireReselect && !game.user.isGM && (nextRound === 'reroll' || nextRound === 'reset' || nextRound === 'hold')) {
          // CRITICAL FIX: Only include combatants who haven't chosen an action yet
          // This prevents race condition where socket action events arrive before updateCombat
          const pendingIds = new Set();
          for (const c of this.combat.combatants) {
            const declared = c.actor?.system?.declaredAction;
            if (!declared || declared === 'nothing') {
              pendingIds.add(c.id);
            }
          }
          this._resetPendingIds = pendingIds;
          _log(`updateCombat | non-GM _resetPendingIds (${this._resetPendingIds.size})`);
          // Immediate refresh to show "Seleziona..." (yellow borders) before socket events clear pending IDs
          this.refreshCards();
          _log(`updateCombat | non-GM immediate refresh`);
        }
        // In group mode, reset the carousel active index to the top of the order before refreshing.
        if (this.isGroupMode) {
          this._sortedTurnIdx = 0;
          if (game.user.isGM) this.combat.setFlag('fantastic-depths-combat-carousel', 'sortedTurnIdx', 0);
        }
        // CRITICAL FIX: When GM receives round change (triggered by client passing last turn),
        // force immediate refresh with all combatants marked as pending so declaredActions show "Seleziona..." (yellow)
        // This applies to individual modes AND group modes
        _log(`updateCombat | GM CHECK | mode=${this.initiativeMode} | isGroup=${this.isGroupMode} | nextRound=${nextRound}`);
        if (requireReselect && game.user.isGM && (this.initiativeMode === 'individual' || this.initiativeMode === 'individualChecklist' || this.initiativeMode === 'simpleIndividual' || this.isGroupMode) && (nextRound === 'reroll' || nextRound === 'reset' || nextRound === 'hold')) {
          this._resetPendingIds = new Set(Array.from(this.combat.combatants).map(c => c.id));
          _log(`updateCombat | GM _resetPendingIds (${this._resetPendingIds.size}) | mode=${this.initiativeMode}`);
          // Immediate refresh to show "Seleziona..." (yellow borders) before actor updates propagate
          this.refreshCards();
          // Deferred refresh to catch any late actor updates (1500ms to allow roundReset patch to finish)
          setTimeout(() => {
            this._roundChanging = false;
            _log(`updateCombat | GM deferred refresh after round change | mode=${this.initiativeMode}`);
            this.refreshCards();
          }, 1500);
        } else if (!requireReselect) {
          this._roundChanging = false;
          this._resetPendingIds?.clear();
        }
        // For individual modes: fix turn=0 so no card appears "active" at start of new round
        if ((this.initiativeMode === 'individual' || this.initiativeMode === 'individualChecklist' || this.initiativeMode === 'simpleIndividual') && game.user.isGM) {
          setTimeout(() => {
            if (this.combat?.started && this.combat.turn !== 0) {
              this.combat.update({ turn: 0 });
            }
          }, 50);
        }
        // Clear all initiatives so cards show the roll button again
        // This applies to: reroll (all modes), reset (individual modes and group modes)
        // NOTE: hold mode does NOT clear initiative - it keeps values from previous round
        const shouldClearInitiative = nextRound === 'reroll' ||
          (nextRound === 'reset' &&
           (this.initiativeMode === 'individual' || this.initiativeMode === 'individualChecklist' || this.initiativeMode === 'simpleIndividual' || this.isGroupMode));
        if (shouldClearInitiative && game.user.isGM) {
          // Use _initiativeClearing flag to prevent _autoRollIfReady from firing during clearing
          this._initiativeClearing = true;
          setTimeout(async () => {
            await Promise.all(Array.from(this.combat.combatants).map(c => c.update({ initiative: null })));
            this._initiativeClearing = false;
            _log(`updateCombat | cleared initiatives for ${nextRound} | mode=${this.initiativeMode}`);
            this.refreshCards();
          }, 300);
        }
      }
      if ('turn' in updates || 'round' in updates) {
        if (this._suppressTurnRefresh && 'turn' in updates && !('round' in updates)) return;
        this.refreshCards();
        this._scrollToActive();
      }
    }) });
  }

  async _startCombatPreservingActions() {
    // Save current declared actions and choseNothing flags before startCombat (FaDe resets them)
    const savedActions = new Map();
    const savedFlags = new Map();
    Array.from(this.combat.combatants).forEach(c => {
      if (c.actor) {
        savedActions.set(c.id, c.actor.system?.combat?.declaredAction);
        savedFlags.set(c.id, c.getFlag('fantastic-depths-combat-carousel', 'choseNothing') ?? false);
      }
    });
    _log('▶ START COMBAT | combatants:', Array.from(this.combat.combatants).map(c => `${c.name} (${c.token?.disposition === 1 ? 'PC' : 'NPC'})`).join(', '));
    _log('  savedActions:', Object.fromEntries(savedActions));
    await this.combat.startCombat();
    this._sortedTurnIdx = this._getSortedIdxForTurn(this.combat.turn ?? 0);
    if (game.user.isGM) this.combat.setFlag('fantastic-depths-combat-carousel', 'sortedTurnIdx', this._sortedTurnIdx);
    // Wait a tick for FaDe's async reset to finish, then restore
    setTimeout(async () => {
      const restores = [];
      Array.from(this.combat.combatants).forEach(c => {
        if (c.actor && savedActions.has(c.id)) {
          const action = savedActions.get(c.id);
          if (action && action !== 'nothing') {
            restores.push(c.actor.update({ 'system.combat.declaredAction': action }));
          }
          if (savedFlags.get(c.id)) {
            restores.push(c.setFlag('fantastic-depths-combat-carousel', 'choseNothing', true));
          }
        }
      });
      await Promise.all(restores);
      this.refreshCards();
    }, 500);
  }

  async _resetDeclaredActions() {
    if (!game.user.isGM) return;
    const updates = Array.from(this.combat.combatants).flatMap(c => {
      if (!c.actor) return [];
      const tasks = [c.actor.update({ 'system.combat.declaredAction': null })];
      if (c.getFlag('fantastic-depths-combat-carousel', 'choseNothing')) {
        tasks.push(c.unsetFlag('fantastic-depths-combat-carousel', 'choseNothing'));
      }
      return tasks;
    });
    await Promise.all(updates);
  }

  _checkDiceFacesWarning() {
    if (!game.user.isGM) return;
    if (this.initiativeMode !== 'individualChecklist') return;
    const formula = game.settings.get(game.system.id, 'initiativeFormula') || '1d6';
    const match = formula.match(/\dd(\d+)/);
    if (!match) return;
    const diceFaces = parseInt(match[1]);
    const numCombatants = this.combat.combatants.size;
    if (numCombatants > diceFaces && !this._diceFacesWarned) {
      this._diceFacesWarned = true;
      ui.notifications.warn(game.i18n.localize('FDCC.WarnDiceFaces'));
    }
  }

  _removeHooks() {
    this._hooks.forEach(h => Hooks.off(h.name, h.id));
    this._hooks = [];
  }

  _scrollToActive() {
    const container = this.element?.querySelector('#carousel-combatants');
    const activeCard = container?.querySelector('.combatant-card.active');
    if (activeCard) {
      activeCard.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }

  close() {
    this.destroy();
  }

  destroy() {
    this._removeHooks();
    if (this.element) {
      this.element.remove();
      this.element = null;
    }
    this.cards = [];
    this.rendered = false;
    if (ui.combatCarousel === this) ui.combatCarousel = null;
  }
}
