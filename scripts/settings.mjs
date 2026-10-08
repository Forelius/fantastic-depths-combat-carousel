const MODULE_ID = 'fantastic-depths-combat-carousel';

export function registerSettings() {
  game.settings.register(MODULE_ID, 'portraitSize', {
    name: 'FDCC.Settings.PortraitSizeName',
    hint: 'FDCC.Settings.PortraitSizeHint',
    scope: 'client',
    config: true,
    type: Number,
    default: 80,
    range: { min: 60, max: 150, step: 5 },
    onChange: (value) => {
      const panel = document.getElementById('combat-carousel-panel');
      if (panel) panel.style.setProperty('--portrait-size', `${value}px`);
    }
  });

  game.settings.register(MODULE_ID, 'showHPBar', {
    name: 'FDCC.Settings.ShowHPBarName',
    hint: 'FDCC.Settings.ShowHPBarHint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, 'showHPBarToPlayers', {
    name: 'FDCC.Settings.ShowHPBarToPlayersName',
    hint: 'FDCC.Settings.ShowHPBarToPlayersHint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, 'showActionDropdown', {
    name: 'FDCC.Settings.ShowActionDropdownName',
    hint: 'FDCC.Settings.ShowActionDropdownHint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, 'forceActionReselect', {
    name: 'FDCC.Settings.ForceActionReselectName',
    hint: 'FDCC.Settings.ForceActionReselectHint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, 'debugMode', {
    name: 'FDCC.Settings.DebugModeName',
    hint: 'FDCC.Settings.DebugModeHint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false
  });
}

/** When true, each new round clears actions to force re-declaration. Default false = FaDe weapon defaults. */
export function forceActionReselect() {
  try { return game.settings.get(MODULE_ID, 'forceActionReselect') === true; } catch (e) { return false; }
}
