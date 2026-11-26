import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ui from '../src/ui.mjs';

const EXPECTED = [
  'ANIM',
  'DOCS_URL',
  'FREE_GROUP',
  'MODEL_PAGE',
  'OTHER_SUB',
  'activeSessionsView',
  'browseGroup',
  'clampPage',
  'composeDraft',
  'defuseTgTags',
  'docsMenuButton',
  'engineGrants',
  'engineMenu',
  'finalExtras',
  'finalMessages',
  'fmtCost',
  'fmtDuration',
  'fmtTokens',
  'hBold',
  'hCode',
  'hRaw',
  'helpMarkup',
  'lastThoughtTitle',
  'modelChosen',
  'modelGrantsOverview',
  'modelGrantsView',
  'modelGroupMenu',
  'modelGroupsOf',
  'modelMenu',
  'modelSearchMenu',
  'modelSubgroupsOf',
  'neutralizeTgTags',
  'pageNav',
  'planBlock',
  'removeReplyKeyboard',
  'replyCommandOf',
  'replyKeyboard',
  'searchModels',
  'sessionStatus',
  'skillName',
  'startView',
  'stepLine',
  'th',
  'toolMeta',
  'trunc',
  'usageView',
];

test('ui.mjs: все публичные экспорты доступны под прежними именами', () => {
  assert.deepEqual(Object.keys(ui).sort(), EXPECTED);
  for (const name of EXPECTED) assert.ok(name in ui, name);
});
