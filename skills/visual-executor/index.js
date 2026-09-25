'use strict';

const fs = require('fs');
const { collectMacOSContext } = require('../../core/macos-context');
const { inspectAccessibility, findElements, performAccessibilityAction } = require('../../core/macos-accessibility');
const { verifyExpectation } = require('../../core/world-model');
const { assessAction } = require('../../core/action-safety-policy');
const { VisualActionLoop } = require('../../core/visual-action-loop');
const desktop = require('../desktop-control');
const vision = require('../screen-vision');

async function locateVisual(name) {
  const imagePath = vision.takeScreenshot();
  try {
    const context = collectMacOSContext();
    const prompt = vision.LOCATE_PROMPT + '\nSo‘rov: ' + name;
    const raw = await vision.describeImage(imagePath, vision.buildGroundedPrompt(prompt, context), { structured: true });
    return vision.normalizeVisionResult(vision.extractJson(raw)).elements;
  } finally { try { fs.unlinkSync(imagePath); } catch (_) {} }
}

function createVisualExecutor(options = {}) {
  const loop = new VisualActionLoop({
    observe: options.observe || (() => collectMacOSContext()),
    inspect: options.inspect || (query => {
      const snapshot = inspectAccessibility({ query });
      return findElements(snapshot.elements, query, { limit: 3 }).map(element => ({ ...element, app: snapshot.app }));
    }),
    actSemantic: options.actSemantic || (({ target, action, value }) => performAccessibilityAction({ app: target.app, path: target.path, action, value })),
    locateVisual: options.locateVisual || locateVisual,
    actVisual: options.actVisual || (({ target, action, value }) => {
      if (action === 'set_value') throw new Error('Visual coordinate text entry is not allowed');
      return desktop.clickAt(target.center.x, target.center.y);
    }),
    verify: options.verify || verifyExpectation,
    authorize: options.authorize || ((action, request) => {
      const assessment = assessAction(action);
      return { allowed: !assessment.requiresConfirmation || request.confirmed === true, assessment };
    }),
    maxAttempts: options.maxAttempts
  });
  return { execute: input => loop.run(input) };
}

module.exports = { createVisualExecutor, locateVisual };