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

    // Warning under the risk meter while Ridgeback closes in on a hazard (rover.js).
    warnings: {
      slope: {
        caution: "Steep slope ahead",
        danger: "Too steep for Ridgeback ahead",
        hereCaution: "On steep ground",
        hereDanger: "Too steep to go on",
      },
      dustRisk: {
        caution: "Mapped sand ahead",
        danger: "Deep sand ahead: Ridgeback will get stuck",
        hereCaution: "On mapped sand",
        hereDanger: "Dug into deep sand: drive out the way you came",
      },
    },

    limits: {
      title: "What Ridgeback can't do",
      steepSlope: "Can't climb very steep slopes. It would tip over.",
      deepSand: "Gets stuck in deep sand, and can only get out the way it came in (forward or in reverse). Avoid dark, loose-looking patches.",
      extremeCold: "Battery drains much faster in extreme cold. Real rover cells hold about a quarter less charge at −20 °C.",
      dustStorm: "Solar panels barely work during a dust storm.",
    },

    status: {
      ready: "Ridgeback is ready. Choose a destination on the map.",
      moving: "Ridgeback is driving. Keep an eye on the battery.",
      charging: "Recharging in sunlight. Waiting is safe, but time is limited.",
      lowBattery: "Battery below 40%, NASA's safe floor. Find a sunny, flat spot or head for the nearest safe point.",
      critical: "Battery critical. Ridgeback will stop soon.",
      stuck: "Ridgeback is stuck. Turn toward the way you came in and drive out, then choose a safer route.",
      arrived: "You made it. Ridgeback has reached the destination.",
      failed: "Ridgeback has run out of power. The mission is over.",
    },

    hints: {
      firstMove: "Pick a destination above, or click a spot on the map or the ground. Then choose a route and press Start drive in the Drive tab.",
      lowPower: "Tip: switch on the Night-time IR layer. Ground that gets coldest at night (dark blue) drains the battery faster.",
      slope: "Tip: the Slope layer shows steep ground. Brighter means steeper.",
      dust: "Tip: a dust storm is coming. Sunlit, flat ground is the best place to wait it out.",
      water: "Tip: the Water Ice layer shows where water may be buried. You'll need it to survive.",
    },

    buttons: {
      go: "Drive here",
      plan: "Plan routes here",
      clear: "Clear",
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
            text: "After testing nearly all of Perseverance's systems, NASA engineers concluded it can keep working until at least 2031.",
            source: "https://www.jpl.nasa.gov/news/nasas-perseverance-mars-rover-ready-to-roll-for-miles-in-years-ahead/",
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

  // Astronaut walk planner (walk.js). The numbers come from walk-core.js
  // (NASA's Artemis suit planning figures); walk.js fills in the {placeholders}.
  walk: {
    intro: "The coloured ground is where an astronaut can walk from Ridgeback and get back safely. Click a spot in it to plan a walk.",
    moreTitle: "Options & limits",
    siteTime: "Time at the site",
    siteOptions: [
      { hours: 0.5, label: "30 min" },
      { hours: 1, label: "1 hour" },
      { hours: 2, label: "2 hours" },
    ],
    legend: {
      easy: "Easy round trip",
      tight: "Fits, but only just",
      safe: "Safe route",
      risky: "Best route, crosses risky ground",
      direct: "Straight line",
    },
    // Shown when Walk is pressed on a route that still crosses risky ground.
    confirm: {
      title: "This walk crosses risky ground",
      body: "The best route still crosses about {list}. There's no safer way there that fits the {plan} plan.",
      advice: "For a safer walk, pick a spot where the route stays white.",
      go: "Walk anyway",
      cancel: "Cancel",
    },
    buttons: {
      start: "Walk",
      stop: "Stop walk",
      clear: "Clear",
    },
    status: {
      moving: "Stop Ridgeback to plan a walk.",
      pick: "Click a spot in the coloured area.",
      safe: "Safest route found. Check the details, then press Walk.",
      tight: "Safest route found, but it only just fits. Check the details, then press Walk.",
      risky: "No fully safe route here: the best one (yellow) crosses risky ground. Check the details before you walk.",
      out: "Walking out · {left} of the plan left",
      site: "Working at the site · {left} of the plan left",
      back: "Walking back to Ridgeback · {left} of the plan left",
      done: "Back inside Ridgeback after {used}, with {reserve} of suit time to spare.",
      stopped: "Walk stopped. The astronaut is back inside Ridgeback.",
      moved: "Ridgeback moved, so the walk was called off.",
      noData: "The walk planner needs the map data, which didn't load.",
    },
    reasons: {
      steep: "Can't walk there: that ground is over {deg}°, the steepest a suited astronaut walks on.",
      cutOff: "Can't walk there: steep ground cuts it off.",
      tooFar: "Too far for a safe walk: there and back plus time at the site comes to {total}, over the {plan} plan.",
    },
    stats: {
      out: "Time there",
      back: "Time back",
      site: "At the site",
      total: "Total",
      totalValue: "{total} of {plan}",
      reserve: "Suit time to spare",
      distance: "Distance, one way",
    },
    // What the safest route steers around, compared with walking straight there.
    risks: {
      tooSteep: "ground too steep to walk",
      steep: "steep slopes",
      sand: "mapped sand",
      boulders: "boulder fields",
      zone: "your hazard zones",
    },
    avoids: "Avoids {list} that the straight line (red) would cross.",
    clear: "No risky ground on the way: the safest route is close to a straight line.",
    crosses: "Still crosses about {list}: there's no safer way that fits the plan.",
    limits:
      "Limits: a {plan} plan per walk, with the suit good for {max}; the rest is reserve. " +
      "{kmh} on flat ground, never on ground over {deg}°. Slopes slow you down (Tobler's hiking function), and so does mapped sand, by 30% (our estimate). " +
      "The route steers around slopes over {risky}° (Apollo crews kept below that), mapped sand, the boulder fields mapped by USGS, and any hazard zones you highlight. " +
      "These are NASA's planning figures for the Artemis Moon suit: NASA has no Mars suit specification yet.",
  },

  // The small "?" buttons next to each group of actions (help.js).
  // Keys match data-help="..." in index.html.
  help: {
    buttonLabel: "What do these do?",
    rover: [
      { name: "Wait and recharge", text: "Stops Ridgeback so its solar panels can refill the battery. Charging is slower on dusty ground." },
      { name: "Start over", text: "Full battery, back at the start site, routes cleared." },
    ],
    plan: [
      { name: "Start site / Destination", text: "Pick where Ridgeback sets off and where it should go. Or click a spot on the map or the ground while this tab is open." },
      { name: "Avoid hazard zones", text: "Keeps routes out of the areas you highlight under Map layers & hazards." },
      { name: "Clear", text: "Removes the destination, its routes and the marker on the map." },
      { name: "Route cards", text: "Three options: Fastest, Safest and Balanced. Pick one, then press Start drive in the Drive tab." },
    ],
    drive: [
      { name: "Auto / Manual", text: "Auto follows the chosen route. Manual lets you steer with W A S D, the arrow keys or the on-screen pad." },
      { name: "Start drive / Stop", text: "Sets off along the chosen route, or pauses." },
      { name: "Restart route", text: "Puts Ridgeback back at the start of the route and drives it again." },
      { name: "Slider", text: "Jump to any point along the route." },
    ],
    view: [
      { name: "Chase cam", text: "Camera follows behind Ridgeback." },
      { name: "Overview", text: "Camera pulls up high to show the whole area." },
      { name: "Speed (1×)", text: "Runs the simulation faster or slower. The battery drains at the same pace." },
    ],
    inspect: [
      { name: "Click a spot", text: "While this tab is open, clicking the map or the ground shows the readings for that spot." },
      { name: "Clear", text: "Removes the marker from the spot you clicked." },
    ],
    walk: [
      { name: "Click a spot", text: "While this tab is open, clicking inside the coloured area plans the safest walk there and back." },
      { name: "Walk / Stop walk", text: "Sets off on the planned walk once you've checked the details, or calls it off. If the route crosses risky ground (yellow), you're asked to confirm first." },
      { name: "Clear", text: "Removes the planned walk." },
      { name: "Time at the site", text: "Under Options & limits: how long the astronaut spends working once they arrive." },
    ],
    map: [
      { name: "+ / −", text: "Zoom the map in or out. Drag to move around when zoomed." },
      { name: "Fit", text: "Shows the whole map again." },
      { name: "Expand map", text: "Makes the map bigger. Click any spot on it to inspect it." },
    ],
  },
};
