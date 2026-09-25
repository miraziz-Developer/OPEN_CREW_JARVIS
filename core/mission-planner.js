'use strict';

const CONNECTOR = /\s+(?:and then|then|after that|afterwards|so['‘’]?ng|keyin|undan keyin|va keyin|hamda)\s+/i;

function cleanStep(value) {
  return String(value || '').replace(/^[,;\s]+|[,;\s]+$/g, '').trim();
}

function splitCommands(command) {
  const text = cleanStep(command);
  if (!text) return [];
  const semicolonParts = text.split(/\s*;\s*/).flatMap(part => part.split(CONNECTOR));
  return semicolonParts.map(cleanStep).filter(Boolean).slice(0, 12);
}

function planCommand(command, options = {}) {
  const descriptions = splitCommands(command);
  const parallel = options.parallel === true;
  const steps = descriptions.map((description, index) => ({
    id: `step-${index + 1}`,
    description,
    dependsOn: parallel || index === 0 ? [] : [`step-${index}`],
    maxAttempts: options.maxAttempts
  }));
  return {
    version: 1,
    goal: cleanStep(command),
    mode: parallel ? 'parallel' : 'sequential',
    steps,
    isMultiCommand: steps.length > 1
  };
}

module.exports = { splitCommands, planCommand };