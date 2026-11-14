// content.js
// All user-facing text lives here. Teammates reference KEYS, never wording.
// Owner: content/testing teammate. Do not hard-code strings in terrain.js,
// data-layers.js, rover.js, ui.js or index.html; import from this file instead.
//
// NOTE: battery numbers in rover.stats match rover.js (BATTERY_WH, PEAK_W,
// LOW_BATTERY). Facts under realPower are from NASA/JPL sources, cited per item.

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
        tooltip:
          "2,408 Wh, the same size as NASA's Perseverance battery. Driving draws about 500 W and never more than 900 W. " +
          "Steep climbs and cold nights drain it faster. Below 40% counts as low: NASA never lets Perseverance go under that.",
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
      extremeCold: "Battery drains much faster in extreme cold. Real rover cells hold about a quarter less charge at −20 °C.",
      dustStorm: "Solar panels barely work during a dust storm.",
    },

    status: {
      ready: "Ridgeback is ready. Choose a destination on the map.",
      moving: "Ridgeback is driving. Keep an eye on the battery.",
      charging: "Recharging in sunlight. Waiting is safe, but time is limited.",
      lowBattery: "Battery below 40%, NASA's safe floor. Find a sunny, flat spot or head for the nearest safe point.",
      critical: "Battery critical. Ridgeback will stop soon.",
      stuck: "Ridgeback is stuck. Try backing out and choosing a flatter route.",
      arrived: "You made it. Ridgeback has reached the destination.",
      failed: "Ridgeback has run out of power. The mission is over.",
    },

    hints: {
      firstMove: "Pick a destination under Navigation, or click the map and press Plan routes here. Then choose the Fastest, Safest or Balanced route and press Start drive.",
      lowPower: "Tip: switch on the Night-time IR layer. Ground that gets coldest at night (dark blue) drains the battery faster.",
      slope: "Tip: the Slope layer shows steep ground. Brighter means steeper.",
      dust: "Tip: a dust storm is coming. Sunlit, flat ground is the best place to wait it out.",
      water: "Tip: the Water Ice layer shows where water may be buried. You'll need it to survive.",
    },

    buttons: {
      go: "Drive here",
      plan: "Plan routes here",
      start: "Start drive",
      again: "Drive it again",
      stop: "Stop",
      recharge: "Wait and recharge",
      reset: "Start over",
    },
  },

  // How NASA's real Mars rovers are powered. Each fact links to its source.
  realPower: {
    title: "How real Mars rovers get power",
    intro:
      "Ridgeback is fictional and runs on solar panels. Its battery size and safety limits come from NASA's real rovers, Curiosity and Perseverance, which use a nuclear generator instead.",
    sections: [
      {
        heading: "Nuclear generator (MMRTG)",
        facts: [
          {
            text: "4.8 kg of plutonium dioxide gives off heat as it decays. Thermocouples turn the temperature difference into electricity (the Seebeck effect).",
            source: "https://www.jpl.nasa.gov/news/press_kits/mars_2020/landing/mission/spacecraft/power",
          },
          {
            text: "About 2,000 W of heat becomes about 110 W of electricity, day and night. The leftover heat keeps the rover warm.",
            source: "https://www.planetary.org/articles/0514-book-excerpt-curiosity-mmrtg",
          },
          {
            text: "Plutonium-238 has a half-life of 87.7 years, but output falls a few percent a year as the thermocouples wear. Curiosity's lost about 1 W every 80 sols.",
            source: "https://www.planetary.org/articles/0514-book-excerpt-curiosity-mmrtg",
          },
          {
            text: "Why not solar? Dust settling on solar panels left Spirit and Opportunity short of power.",
            source: "https://science.nasa.gov/resource/mars-rover-power",
          },
        ],
      },
      {
        heading: "Batteries",
        facts: [
          {
            text: "The generator trickle-charges two lithium-ion batteries (about 43 Ah each, 2,408 Wh in all). They cover peaks of up to 900 W during science work.",
            source: "https://www.jpl.nasa.gov/news/press_kits/mars_2020/landing/mission/spacecraft/power",
          },
          {
            text: "Each sol NASA checks that the charge stays at or above 40%, current stays at or below 12 A per battery, and bus voltage stays between 29.3 and 32.8 V.",
            source: "https://www.nasa.gov/wp-content/uploads/2024/01/battery-system-design-testing-and-operation-for-the-mars-perseverance-rover-and-ingenuity-helicopter.pdf",
          },
          {
            text: "Built to last over 7 years and 2,010 cycles. In tests the cells gave at least 40.5 Ah at +35 °C but only 30 Ah at −20 °C.",
            source: "https://www.nasa.gov/wp-content/uploads/2024/01/battery-system-design-testing-and-operation-for-the-mars-perseverance-rover-and-ingenuity-helicopter.pdf",
          },
          {
            text: "After about 210 sols on Mars, capacity had dropped by under one percentage point, roughly 1.5 points per Earth year.",
            source: "https://www.nasa.gov/wp-content/uploads/2024/01/battery-system-design-testing-and-operation-for-the-mars-perseverance-rover-and-ingenuity-helicopter.pdf",
          },
        ],
      },
      {
        heading: "Ingenuity helicopter",
        facts: [
          {
            text: "Six Sony 18650 lithium-ion cells (2 Ah each, about 44 Wh) powered flights of up to 510 W (360 W continuous).",
            source: "https://www.nasa.gov/wp-content/uploads/2024/01/battery-system-design-testing-and-operation-for-the-mars-perseverance-rover-and-ingenuity-helicopter.pdf",
          },
          {
            text: "The battery had to be warmed to about 20 °C before each flight.",
            source: "https://www.nasa.gov/wp-content/uploads/2024/01/battery-system-design-testing-and-operation-for-the-mars-perseverance-rover-and-ingenuity-helicopter.pdf",
          },
        ],
      },
      {
        heading: "How long they last",
        facts: [
          {
            text: "The generator is designed to run for at least 14 years.",
            source: "https://www.jpl.nasa.gov/news/press_kits/mars_2020/landing/mission/spacecraft/power",
          },
          {
            text: "NASA expects Perseverance to keep working until at least 2031. As power slowly falls, the team will have to do less each day.",
            source: "https://www.yahoo.com/news/articles/nasas-perseverance-mars-rover-could-150000300.html",
          },
          {
            text: "After 13 years Curiosity saves energy by doing tasks at the same time and sleeping early to recharge.",
            source: "https://www.nasa.gov/missions/mars-science-laboratory/curiosity-rover/marking-13-years-on-mars-nasas-curiosity-picks-up-new-skills",
          },
        ],
      },
    ],
    sourceLabel: "Source",
  },
};
