/**
 * D&D 5e Domain Plugin for MCP Tournament.
 * 
 * Ported from Oracle Tournament. Evaluates AI models as D&D Dungeon Masters
 * using structured scenarios, a test character, and simulated DM tools.
 */

import type { TournamentPlugin, TestCase, Turn, ToolDefinition } from './base.js';
import { getModelClient } from '../clients/index.js';
import { PARTICIPANT_AGENT_MODEL, PARTICIPANT_AGENT_ROUTE } from '../config/judges.js';
import { MAX_TOKENS_PARTICIPANT } from '../config/constants.js';

// ── Test Character ──────────────────────────────────────

export interface TestCharacter {
  name: string;
  race: string;
  class: string;
  level: number;
  background: string;
  appearance: string;
  stats: Record<string, number>;
  hp: { current: number; max: number };
  ac: number;
  skills: Record<string, number>;
  equipment: string[];
  companions: Array<{ name: string; type: string; hp: number; ac: number }>;
  spells: string[];
  attacks: Array<{ name: string; to_hit: number; damage: string; damage_type: string }>;
  saving_throws: Record<string, number>;
}

export const TEST_CHARACTER: TestCharacter = {
  name: 'Sera Nightbloom',
  race: 'Half-Elf',
  class: 'Ranger',
  level: 5,
  background: 'Outlander',
  appearance: 'Female, lean and weathered, dark auburn hair in a loose braid, pale green eyes, a thin scar from right temple to jawline, leather armor stained by forest travel',
  stats: { strength: 12, dexterity: 18, constitution: 14, intelligence: 10, wisdom: 16, charisma: 11 },
  hp: { current: 42, max: 42 },
  ac: 15,
  skills: {
    athletics: 3, acrobatics: 6, stealth: 8, perception: 7, survival: 7,
    nature: 4, investigation: 4, insight: 7, medicine: 3, animal_handling: 7,
  },
  equipment: [
    'Longbow +1 (quiver with 30 arrows)', 'Two short swords', 'Leather armor',
    'Explorers pack', 'Bedroll', 'Rope (50ft)', 'Hunting trap',
    'Potion of Healing x2', 'Gold: 47gp, 12sp',
  ],
  companions: [{ name: 'Fenris', type: 'Wolf', hp: 11, ac: 13 }],
  spells: ['Hunters Mark', 'Cure Wounds', 'Longstrider', 'Speak with Animals'],
  attacks: [
    { name: 'Longbow +1', to_hit: 8, damage: '1d8+5', damage_type: 'piercing' },
    { name: 'Short Sword', to_hit: 6, damage: '1d6+4', damage_type: 'slashing' },
  ],
  saving_throws: { strength: 3, dexterity: 8, constitution: 4, intelligence: 2, wisdom: 5, charisma: 2 },
};

// ── Scenarios ───────────────────────────────────────────

export const DND_SCENARIOS: TestCase[] = [
  {
    id: 'dnd-combat',
    name: 'The Moonlit Ambush',
    description: 'Combat narration, pacing, dice integration',
    setupMessage: `You are a D&D 5th Edition Dungeon Master. Sera Nightbloom is traveling through a moonlit forest when she hears movement in the treeline. Three goblins leap out, led by a bugbear. Roll initiative and begin combat.`,
    goalCard: 'Test: combat narration, initiative pacing, dice integration, tactical awareness',
    minTurns: 4,
    maxTurns: 8,
    context: { character: TEST_CHARACTER },
    gradingCriteria: [
      { name: 'rules_accuracy', description: 'Follows 5e combat rules correctly' },
      { name: 'narrative_quality', description: 'Combat feels dramatic, not mechanical' },
      { name: 'dice_integration', description: 'Dice rolls feel natural in narration' },
    ],
  },
  {
    id: 'dnd-roleplay',
    name: 'The Wailing Widow',
    description: 'NPC depth, emotional range, improvisation',
    setupMessage: `You are a D&D 5th Edition Dungeon Master. Sera enters a tavern in a rain-soaked village. A widow is weeping at the bar — her husband was killed by something in the old mines. She approaches Sera for help.`,
    goalCard: 'Test: NPC depth, emotional range, player agency, improvised dialogue',
    minTurns: 4,
    maxTurns: 8,
    context: { character: TEST_CHARACTER },
    gradingCriteria: [
      { name: 'npc_depth', description: 'NPC feels like a real person, not a quest-giver' },
      { name: 'emotional_range', description: 'Conveys genuine emotion' },
      { name: 'player_agency', description: 'Player choices matter and shape the conversation' },
    ],
  },
  {
    id: 'dnd-puzzle',
    name: 'The Puzzle Vault',
    description: 'Rules knowledge, puzzle design, environmental storytelling',
    setupMessage: `You are a D&D 5th Edition Dungeon Master. Sera discovers a sealed vault door with three pressure plates, each marked with a different rune. Ancient text on the wall reads: "Only the patient, the brave, and the clever may pass."`,
    goalCard: 'Test: puzzle design, rules knowledge, environmental storytelling, player agency',
    minTurns: 4,
    maxTurns: 8,
    context: { character: TEST_CHARACTER },
  },
  {
    id: 'dnd-negotiation',
    name: 'The Dragon\'s Bargain',
    description: 'Multi-NPC negotiation, voice differentiation',
    setupMessage: `You are a D&D 5th Edition Dungeon Master. Sera is brought before a young copper dragon who has captured a merchant caravan. The dragon wants entertainment in exchange for the merchants' freedom. The merchants are panicking.`,
    goalCard: 'Test: multi-NPC management, voice differentiation, negotiation mechanics',
    minTurns: 5,
    maxTurns: 10,
    context: { character: TEST_CHARACTER },
  },
  {
    id: 'dnd-memory',
    name: 'The Long Memory',
    description: 'Continuity, campaign memory, world evolution',
    setupMessage: `You are a D&D 5th Edition Dungeon Master running a long campaign. Sera returns to the village of Millbrook after a 3-session absence. Last time, she saved the blacksmith's daughter but accidentally burned down the chapel. The village should remember.`,
    goalCard: 'Test: continuity, memory of past events, world evolution, consequence tracking',
    minTurns: 4,
    maxTurns: 8,
    context: { character: TEST_CHARACTER, memory: { recentEvents: ['Saved blacksmith\'s daughter', 'Burned down chapel'], npcs: [{ name: 'Garrick', role: 'Blacksmith', location: 'Millbrook', notes: 'Grateful for daughter\'s rescue', disposition: 'Friendly' }] } },
  },
  {
    id: 'dnd-improv',
    name: 'The Curveball',
    description: 'Improvisation, handling unexpected player actions',
    setupMessage: `You are a D&D 5th Edition Dungeon Master. Sera is in the middle of a formal dinner with a noble family when she suddenly decides to cast Speak with Animals and interrogate the noble's prize hunting falcon about "what it has seen."`,
    goalCard: 'Test: improvisation, handling unexpected actions, humor, maintaining world consistency',
    minTurns: 3,
    maxTurns: 6,
    context: { character: TEST_CHARACTER },
  },
];

const DND_TOOLS: ToolDefinition[] = [{
  name: 'roll_dice',
  description: 'Roll dice using notation such as 1d20+5.',
  parameters: {
    type: 'object',
    properties: {
      notation: { type: 'string', description: 'Dice notation such as 2d6+3' },
    },
    required: ['notation'],
  },
  async handler(args): Promise<string> {
    const notation = String(args.notation ?? '');
    const match = notation.match(/^(\d+)d(\d+)([+-]\d+)?$/i);
    if (!match) throw new Error('notation must look like 1d20+5');
    const count = Number(match[1]);
    const sides = Number(match[2]);
    const modifier = Number(match[3] ?? 0);
    if (count < 1 || count > 100 || sides < 2 || sides > 1000) {
      throw new Error('dice count or sides out of range');
    }
    const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
    const total = rolls.reduce((sum, roll) => sum + roll, modifier);
    return JSON.stringify({ notation, rolls, modifier, total });
  },
}];

// ── Plugin Definition ───────────────────────────────────

export const dndPlugin: TournamentPlugin = {
  name: 'dnd',
  description: 'D&D 5th Edition Dungeon Master evaluation. Tests AI models on combat, roleplay, puzzle design, and improvisation.',
  version: '1.0.0',
  scenarios: DND_SCENARIOS,
  tools: DND_TOOLS,

  buildCandidatePrompt(scenario: TestCase): string {
    const char = scenario.context?.character as TestCharacter | undefined;
    const charSheet = char ? `\n\nPlayer Character:\n- Name: ${char.name}\n- Race: ${char.race} ${char.class} Level ${char.level}\n- HP: ${char.hp.current}/${char.hp.max}\n- AC: ${char.ac}\n- Stats: ${Object.entries(char.stats).map(([k, v]) => `${k.slice(0, 3).toUpperCase()} ${v}`).join(', ')}\n- Equipment: ${char.equipment.join(', ')}\n- Spells: ${char.spells.join(', ')}\n- Companion: ${char.companions.map(c => `${c.name} (${c.type}, HP ${c.hp}, AC ${c.ac})`).join(', ')}` : '';

    return `You are an AI Dungeon Master for D&D 5th Edition. You run the game by the book — 5e SRD rules, real dice rolls, tactical combat, meaningful roleplay.

Rules:
- Roll dice for everything (initiative, attacks, saves, damage). Use the roll_dice tool.
- Track HP, conditions, spell slots for all combatants.
- Give the player meaningful choices. Never railroad.
- Narrate cinematically. Show, don't tell.
- NPCs have distinct voices, motivations, and knowledge limits.
- Combat should feel dangerous. Don't fudge rolls in the player's favor.

${charSheet}

${scenario.setupMessage}`;
  },

  buildJudgePrompt(role: string, scenario: TestCase, turns: Turn[]): string {
    const transcript = turns.map(t => `[Turn ${t.turn} - ${t.role}]: ${t.content}`).join('\n\n');
    const criteria = scenario.gradingCriteria?.map(c => `- ${c.name}: ${c.description}`).join('\n') || 'General quality';

    const rolePrompts: Record<string, string> = {
      rules: `You are the Rules Judge. Score this D&D session for mechanical accuracy.\n\nCriteria:\n${criteria}\n\nCheck: correct dice math, proper 5e mechanics, valid tool calls, combat flow.\n\nTranscript:\n${transcript}`,
      creative: `You are the Creative Judge. Score this D&D session for narrative quality.\n\nCriteria:\n${criteria}\n\nCheck: atmosphere, pacing, show-don't-tell, improvised drama, NPC voice.\n\nTranscript:\n${transcript}`,
      holistic: `You are the Holistic Judge. Score this D&D session for player experience.\n\nCriteria:\n${criteria}\n\nCheck: "Would I keep playing?", player agency, dramatic payoff, empowerment.\n\nTranscript:\n${transcript}`,
    };

    return rolePrompts[role] || rolePrompts.holistic;
  },

  async generateParticipantMessage(scenario: TestCase, turns: Turn[]): Promise<string> {
    const lastDM = turns.filter(t => t.role === 'candidate').pop();
    if (!lastDM) return 'I cautiously look around, hand on my bow.';

    const fallback = FALLBACK_PLAYER_LINES[Math.floor(turns.length / 2) % FALLBACK_PLAYER_LINES.length];
    if (!process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_DICE_ORACLE_API_KEY) {
      return fallback;
    }

    try {
      const transcript = turns
        .map(t => `${t.role === 'candidate' ? 'DM' : 'PLAYER'}: ${t.content}`)
        .join('\n\n');
      const response = await getModelClient(PARTICIPANT_AGENT_ROUTE).createMessage({
        model: PARTICIPANT_AGENT_MODEL,
        system: `You are roleplaying ${TEST_CHARACTER.name}, a level ${TEST_CHARACTER.level} ${TEST_CHARACTER.race} ${TEST_CHARACTER.class}, as a player at a D&D table. Reply with what the PLAYER says: 1-3 sentences of action and/or dialogue, first person, in character. Declare intent — never narrate outcomes, roll dice, or speak for NPCs (that is the DM's job).`,
        messages: [{
          role: 'user',
          content: `Scenario goal: ${scenario.goalCard}\n\nSession so far:\n${transcript}\n\nWhat do you do next?`,
        }],
        max_tokens: MAX_TOKENS_PARTICIPANT,
      });
      return response.text.trim() || fallback;
    } catch {
      return fallback;
    }
  },
};

/** Used when no OpenRouter key is configured (offline tests) or the participant call fails. */
const FALLBACK_PLAYER_LINES = [
  'I draw my bow and take aim. "Show yourselves!"',
  'I take a cautious step forward, scanning for traps.',
  'I speak calmly. "I mean no harm. Let us talk."',
  'I cast Hunters Mark on the nearest enemy and ready an attack.',
  'I kneel down and examine the runes more carefully.',
  'I look at the widow with concern. "Tell me everything. Start from the beginning."',
];
