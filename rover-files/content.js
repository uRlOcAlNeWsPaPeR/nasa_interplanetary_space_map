// content.js
// All user-facing text lives here. Teammates reference KEYS, never wording.
// Owner: content/testing teammate. Do not hard-code strings in terrain.js,
// data-layers.js, rover.js, ui.js or index.html; import from this file instead.
//
// NOTE: numbers under rover.stats are PLACEHOLDERS. Match them to whatever
// rover.js actually uses, or tell me the real values and I'll update the text.

export const content = {
  rover: {
    name: "Ridgeback",
    tagline: "Your six-wheeled lifeline across Mars.",
    description:
      "Ridgeback is a small, solar-powered rover. It carries you, or your supplies, across the Martian surface. " +
      "It moves slowly and its battery is limited, so every route you pick is a trade-off between speed and safety.",

    stats: {
      speed: {
        label: "Speed",
        value: "Slow and steady",
        tooltip: "Mars has no roads. Ridgeback crawls so it doesn't tip over or get stuck in loose sand.",
      },
      battery: {
        label: "Battery",
        tooltip: "Powers the wheels and instruments. Steep climbs and cold nights drain it faster.",
      },
      solar: {
        label: "Solar charge",
        tooltip: "Panels recharge the battery in daylight. Dust storms block the sun and slow charging.",
      },
      sensors: {
        label: "Sensors",
        value: "Temperature, slope, dust, ice",
        tooltip: "Ridgeback reads the ground around it and feeds the map layers you see.",
      },
    },

    limits: {
      title: "What Ridgeback can't do",
      steepSlope: "Can't climb very steep slopes. It would tip over.",
      deepSand: "Gets stuck in deep sand. Avoid dark, loose-looking patches.",
      extremeCold: "Battery drains much faster in extreme cold.",
      dustStorm: "Solar panels barely work during a dust storm.",
    },

    status: {
      ready: "Ridgeback is ready. Choose a destination on the map.",
      moving: "Ridgeback is driving. Keep an eye on the battery.",
      charging: "Recharging in sunlight. Waiting is safe, but time is limited.",
      lowBattery: "Battery low. Find a sunny, flat spot or head for the nearest safe point.",
      critical: "Battery critical. Ridgeback will stop soon.",
      stuck: "Ridgeback is stuck. Try backing out and choosing a flatter route.",
      arrived: "You made it. Ridgeback has reached the destination.",
      failed: "Ridgeback has run out of power. The mission is over.",
    },

    hints: {
      firstMove: "Click anywhere on the map to send Ridgeback there. Check the layers first: not every path is safe.",
      lowPower: "Tip: switch on the Thermal layer to avoid cold zones that drain the battery.",
      slope: "Tip: the Elevation layer shows steep areas. Darker means steeper.",
      dust: "Tip: a dust storm is coming. Sunlit, flat ground is the best place to wait it out.",
      water: "Tip: the Water Ice layer shows where water may be buried. You'll need it to survive.",
    },

    buttons: {
      go: "Drive here",
      stop: "Stop",
      recharge: "Wait and recharge",
      reset: "Start over",
    },
  },
};
