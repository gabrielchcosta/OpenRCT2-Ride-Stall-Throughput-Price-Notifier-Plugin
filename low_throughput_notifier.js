// Cooldown tracking storage (ride ID -> game tick)
const cooldowns = new Map();

// List of thoughts
const EXPENSIVE_RIDE_THOUGHTS = new Set(["bad_value"]);
const GOOD_VALUE_RIDE_THOUGHTS = new Set(["good_value"]);
const SHOP_VALUE_THOUGHTS = new Set([
    "balloon", "toy", "map", "photo", "umbrella", "drink", "burger", "chips",
    "ice_cream", "candyfloss", "pizza", "popcorn", "hot_dog", "tentacle", "hat",
    "toffee_apple", "tshirt", "doughnut", "coffee", "chicken", "lemonade", "photo2",
    "photo3", "photo4", "pretzel", "hot_chocolate", "iced_tea", "funnel_cake",
    "sunglasses", "beef_noodles", "fried_rice_noodles", "wonton_soup", "meatball_soup",
    "fruit_juice", "soybean_milk", "sujongkwa", "sub_sandwich", "cookie", "roast_sausage"
]);
const SHOP_ITEM_NAMES = {
    photo2: "On-Ride Photo",
    photo3: "On-Ride Photo",
    photo4: "On-Ride Photo",
    tshirt: "T-shirt",
    sunglasses: "pair of sunglasses"
};
const SETTINGS_KEY = "RidePriceComplaintNotifier";
const DEFAULT_COOLDOWN_MINUTES = 4;
const MIN_COOLDOWN_MINUTES = 1;
const MAX_COOLDOWN_MINUTES = 30;
const DEFAULT_NOTIFICATION_COOLDOWN_SECONDS = 30;
const DEFAULT_THRESHOLD_GUESTS = 1;
const MIN_SETTING = 1;
const MAX_SETTING = 10;
const MIN_NOTIFICATION_COOLDOWN_SECONDS = 5;
const MAX_NOTIFICATION_COOLDOWN_SECONDS = 300;
const DEFAULT_THROUGHPUT_THRESHOLD = 45;
const THROUGHPUT_REQUIRED_SAMPLES = 10;
const THROUGHPUT_SCAN_INTERVAL_SECONDS = 60;
const THROUGHPUT_SAMPLE_WINDOW_TICKS = 40 * 60 * 10;
const DEFAULT_MIN_RIDE_AGE_MONTHS = 2;
const DEFAULT_MIN_STALL_AGE_MONTHS = 1;
const GLOBAL_TAB_ICON = { frameBase: 5201, frameCount: 4, frameDuration: 4 };
const THROUGHPUT_TAB_ICON = { frameBase: 5568, frameCount: 8, frameDuration: 4 };
const PRICE_TAB_ICON = { frameBase: 5253, frameCount: 8, frameDuration: 4 };
const THROUGHPUT_CATEGORIES = [
    { key: "transport", label: "Transport", defaultThreshold: 200 },
    { key: "water", label: "Water", defaultThreshold: 700 },
    { key: "gentle", label: "Gentle", defaultThreshold: 250 },
    { key: "thrill", label: "Thrill", defaultThreshold: 450 },
    { key: "rollerCoaster", label: "Roller coaster", defaultThreshold: 1000 },
    { key: "other", label: "Other rides", defaultThreshold: 150 }
];
const IGNORED_RIDE_TYPES = [
    { key: "cinema3d", label: "3D cinema", identifiers: ["3d cinema", "3d_cinema", "3dcinema"] },
    { key: "boatHire", label: "Boat hire", identifiers: ["boat hire", "boat_hire"] },
    { key: "bumperCars", label: "Bumper cars", identifiers: ["bumper cars", "bumper_cars", "dodgems"] },
    { key: "circus", label: "Circus", identifiers: ["circus"] },
    { key: "crookedHouse", label: "Crooked house", identifiers: ["crooked house", "crooked_house"] },
    { key: "ferrisWheel", label: "Ferris wheel", identifiers: ["ferris wheel", "ferris_wheel"] },
    { key: "flyingSaucers", label: "Flying saucers", identifiers: ["flying saucers", "flying_saucers"] },
    { key: "hauntedHouse", label: "Haunted house", identifiers: ["haunted house", "haunted_house"] },
    { key: "miniGolf", label: "Mini golf", identifiers: ["mini golf", "mini_golf"] },
    { key: "spaceRings", label: "Space rings", identifiers: ["space rings", "space_rings"] },
    { key: "spiralSlide", label: "Spiral slide", identifiers: ["spiral slide", "spiral_slide"] },
    { key: "twist", label: "Twist", identifiers: ["twist"] }
];

let settings;
let lastScanTick;
let lastNotificationTick;
// Keep a short history so throughput is based on actual traffic
const throughputSamples = new Map();

function getPriceThoughtKind(type) {
    if (EXPENSIVE_RIDE_THOUGHTS.has(type)) return "expensive";
    if (GOOD_VALUE_RIDE_THOUGHTS.has(type) || SHOP_VALUE_THOUGHTS.has(type)) return "good_value";
    if (type.endsWith("_much") && SHOP_VALUE_THOUGHTS.has(type.slice(0, -5))) return "expensive";
    return null;
}

function getShopItemName(type) {
    const itemType = type.endsWith("_much") ? type.slice(0, -5) : type;
    return SHOP_ITEM_NAMES[itemType] || itemType.replace(/_/g, " ") || "item";
}

function isShopItemThought(type) {
    const itemType = type.endsWith("_much") ? type.slice(0, -5) : type;
    return SHOP_VALUE_THOUGHTS.has(itemType);
}

function isStallOrFacility(ride) {
    return ride.classification === "stall" || ride.classification === "facility";
}

function isInformationKiosk(ride) {
    const object = ride.object || {};
    const identity = [
        object.identifier,
        object.category,
        object.type,
        object.name,
        object.id,
        object.objectIdentifier,
        object.objectType,
        ride.type,
        ride.name
    ].filter(value => value !== undefined && value !== null)
        .join(" ").toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    return identity.indexOf("information kiosk") !== -1 ||
        identity.indexOf("informationkiosk") !== -1;
}

function isInformationKioskValueThought(type) {
    return type === "map" || type === "map_much" ||
        type === "umbrella" || type === "umbrella_much";
}

function shouldIgnoreMapUmbrellaThought(ride, type) {
    return settings.ignoreInformationKiosks &&
        isInformationKioskValueThought(type) &&
        (isInformationKiosk(ride) || isStallOrFacility(ride));
}

function getCooldownKey(ride) {
    return isStallOrFacility(ride)
        ? `stall:${ride.type}`
        : `ride:${ride.id}`;
}

function loadSettings() {
    // Load saved values or use the defaults for a fresh setup
    const loaded = {
        cooldownMinutes: normalizeCooldownMinutes(
            context.sharedStorage.get(`${SETTINGS_KEY}.cooldownMinutes`, DEFAULT_COOLDOWN_MINUTES)
        ),
        notificationCooldownSeconds: normalizeNotificationCooldownSeconds(
            context.sharedStorage.get(`${SETTINGS_KEY}.notificationCooldownSeconds`, DEFAULT_NOTIFICATION_COOLDOWN_SECONDS)
        ),
        thresholdRideGuests: normalizeSetting(
            context.sharedStorage.get(
                `${SETTINGS_KEY}.thresholdRideGuests`,
                context.sharedStorage.get(`${SETTINGS_KEY}.thresholdGuests`, DEFAULT_THRESHOLD_GUESTS)
            )
        ),
        thresholdStallGuests: normalizeSetting(
            context.sharedStorage.get(
                `${SETTINGS_KEY}.thresholdStallGuests`,
                context.sharedStorage.get(`${SETTINGS_KEY}.thresholdGuests`, DEFAULT_THRESHOLD_GUESTS)
            )
        ),
        notifyGoodValueRides: context.sharedStorage.get(
            `${SETTINGS_KEY}.notifyGoodValueRides`,
            context.sharedStorage.get(`${SETTINGS_KEY}.notifyGoodValue`, true)
        ) === true,
        notifyGoodValueStalls: context.sharedStorage.get(
            `${SETTINGS_KEY}.notifyGoodValueStalls`,
            context.sharedStorage.get(`${SETTINGS_KEY}.notifyGoodValue`, true)
        ) === true,
        notifyExpensiveRides: context.sharedStorage.get(
            `${SETTINGS_KEY}.notifyExpensiveRides`,
            context.sharedStorage.get(`${SETTINGS_KEY}.notifyExpensive`, true)
        ) === true,
        notifyExpensiveStalls: context.sharedStorage.get(
            `${SETTINGS_KEY}.notifyExpensiveStalls`,
            context.sharedStorage.get(`${SETTINGS_KEY}.notifyExpensive`, true)
        ) === true,
        ignoreInformationKiosks: context.sharedStorage.get(
            `${SETTINGS_KEY}.ignoreInformationKiosks`,
            context.sharedStorage.get(`${SETTINGS_KEY}.ignoreExpensiveUmbrellas`, false)
        ) === true,
        stallThroughput: context.sharedStorage.get(`${SETTINGS_KEY}.stallThroughput`, true) === true,
        stallThroughputThreshold: normalizeThroughputThreshold(
            context.sharedStorage.get(`${SETTINGS_KEY}.stallThroughputThreshold`, DEFAULT_THROUGHPUT_THRESHOLD)
        ),
        rideThroughput: context.sharedStorage.get(`${SETTINGS_KEY}.rideThroughput`, true) === true,
        minRideAgeMonths: normalizeAgeMonths(
            context.sharedStorage.get(`${SETTINGS_KEY}.minRideAgeMonths`, DEFAULT_MIN_RIDE_AGE_MONTHS)
        ),
        minStallAgeMonths: normalizeAgeMonths(
            context.sharedStorage.get(`${SETTINGS_KEY}.minStallAgeMonths`, DEFAULT_MIN_STALL_AGE_MONTHS)
        )
    };
    THROUGHPUT_CATEGORIES.forEach(category => {
        loaded[`${category.key}ThroughputThreshold`] = normalizeThroughputThreshold(
            context.sharedStorage.get(
                `${SETTINGS_KEY}.${category.key}ThroughputThreshold`,
                category.defaultThreshold
            )
        );
    });
    IGNORED_RIDE_TYPES.forEach(rideType => {
        loaded[`ignore${rideType.key[0].toUpperCase()}${rideType.key.slice(1)}`] =
            context.sharedStorage.get(`${SETTINGS_KEY}.ignore${rideType.key[0].toUpperCase()}${rideType.key.slice(1)}`, false) === true;
    });
    return loaded;
}

function normalizeCooldownMinutes(value) {
    const number = Number(value);
    return Number.isInteger(number)
        ? Math.max(MIN_COOLDOWN_MINUTES, Math.min(MAX_COOLDOWN_MINUTES, number))
        : DEFAULT_COOLDOWN_MINUTES;
}

function normalizeSetting(value) {
    const number = Number(value);
    return Number.isInteger(number) ? Math.max(MIN_SETTING, Math.min(MAX_SETTING, number)) : MIN_SETTING;
}

function normalizeNotificationCooldownSeconds(value) {
    const number = Number(value);
    return Number.isInteger(number)
        ? Math.max(MIN_NOTIFICATION_COOLDOWN_SECONDS, Math.min(MAX_NOTIFICATION_COOLDOWN_SECONDS, number))
        : DEFAULT_NOTIFICATION_COOLDOWN_SECONDS;
}

function normalizeThroughputThreshold(value) {
    const number = Number(value);
    return Number.isInteger(number) ? Math.max(0, Math.min(10000, number)) : DEFAULT_THROUGHPUT_THRESHOLD;
}

function normalizeAgeMonths(value) {
    const number = Number(value);
    return Number.isInteger(number) ? Math.max(0, Math.min(120, number)) : 0;
}

function saveSetting(name, value) {
    const number = Number(value);
    if (!Number.isInteger(number)) return;

    settings[name] = name === "cooldownMinutes"
        ? normalizeCooldownMinutes(number)
        : normalizeSetting(number);
    context.sharedStorage.set(`${SETTINGS_KEY}.${name}`, settings[name]);
}

function saveThroughputThreshold(name, value) {
    const number = Number(value);
    if (!Number.isInteger(number)) return;

    settings[name] = normalizeThroughputThreshold(number);
    context.sharedStorage.set(`${SETTINGS_KEY}.${name}`, settings[name]);
}

function saveAgeMonths(name, value) {
    const number = Number(value);
    if (!Number.isInteger(number)) return;

    settings[name] = normalizeAgeMonths(number);
    context.sharedStorage.set(`${SETTINGS_KEY}.${name}`, settings[name]);
}

function saveNotificationCooldownSeconds(value) {
    const number = Number(value);
    if (!Number.isInteger(number)) return;

    settings.notificationCooldownSeconds = normalizeNotificationCooldownSeconds(number);
    context.sharedStorage.set(`${SETTINGS_KEY}.notificationCooldownSeconds`, settings.notificationCooldownSeconds);
}

function saveToggle(name, value) {
    settings[name] = Boolean(value);
    context.sharedStorage.set(`${SETTINGS_KEY}.${name}`, settings[name]);
}

function createToggle(x, y, width, name, text, tooltip) {
    //Keep the checkbox and saved setting in sync while the window is open when you switch tabs
    const widget = {
        type: "checkbox",
        x,
        y,
        width,
        height: 18,
        name,
        text,
        tooltip,
        isChecked: settings[name],
        onChange: value => {
            saveToggle(name, value);
            widget.isChecked = Boolean(value);
        }
    };
    return widget;
}

function syncVisibleToggleWidgets(window) {
    window.widgets.forEach(widget => {
        if (widget.type === "checkbox" && widget.name) {
            widget.isChecked = Boolean(settings[widget.name]);
        }
    });
}

function createNumericField(x, y, width, name, tooltip, save) {
    return {
        type: "textbox",
        x,
        y,
        width,
        height: 16,
        text: String(settings[name]),
        maxLength: 5,
        tooltip,
        onChange: value => save(value)
    };
}

function getRideCategory(ride) {
    // Work out which threshold applies to this ride
    const object = ride.object || {};
    const category = String(object.category || object.type || "").toLowerCase();
    if (category.indexOf("transport") !== -1 ||
        /boat_hire|chairlift|lift|miniature_railway|monorail/.test(category)) return "transport";
    if (category.indexOf("water") !== -1 ||
        /dinghy|flume|river|splash|submarine|boat/.test(category)) return "water";
    if (category.indexOf("coaster") !== -1 || /_rc$|bobsleigh/.test(category)) return "rollerCoaster";
    if (category.indexOf("gentle") !== -1 ||
        /3d_cinema|circus|crooked_house|ferris|ghost_train|haunted_house|magic_carpet|maze|merry|mini_golf|observation|spiral_slide/.test(category)) {
        return "gentle";
    }
    if (category.indexOf("thrill") !== -1 ||
        /dodgems|enterprise|flying_saucers|go_karts|freefall|motion_simulator|roto_drop|swinging|top_spin|twist/.test(category)) {
        return "thrill";
    }

    const identifier = String(object.identifier || "").toLowerCase();
    if (identifier.indexOf("mono") !== -1 || identifier.indexOf("tram") !== -1 ||
        identifier.indexOf("train") !== -1 || identifier.indexOf("chair") !== -1) return "transport";
    if (identifier.indexOf("boat") !== -1 || identifier.indexOf("flum") !== -1 ||
        identifier.indexOf("river") !== -1 || identifier.indexOf("water") !== -1) return "water";
    return "other";
}

function isIgnoredRide(ride) {
    // Ignore checks use the ride type, not its custom display name
    const object = ride.object || {};
    const identity = [
        ride.object,
        object.identifier,
        object.category,
        object.type,
        object.name,
        object.id,
        object.objectIdentifier,
        object.objectType,
        ride.type,
        ride.name
    ].filter(value => value !== undefined && value !== null)
        .join(" ").toLowerCase();
    const normalizedIdentity = identity.replace(/[^a-z0-9]+/g, " ").trim();
    const compactIdentity = normalizedIdentity.replace(/\s+/g, "");
    return IGNORED_RIDE_TYPES.some(rideType => {
        const settingName = `ignore${rideType.key[0].toUpperCase()}${rideType.key.slice(1)}`;
        return settings[settingName] && rideType.identifiers.some(value => {
            const normalizedValue = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
            return normalizedIdentity === normalizedValue ||
                normalizedIdentity.indexOf(` ${normalizedValue} `) !== -1 ||
                normalizedIdentity.indexOf(`${normalizedValue} `) === 0 ||
                normalizedIdentity.endsWith(` ${normalizedValue}`) ||
                compactIdentity.indexOf(normalizedValue.replace(/\s+/g, "")) !== -1;
        });
    });
}

function getCustomersPerHour(ride, currentTick) {
    // Use the customer counter because the ride's built-in value is unreliable
    if (!Number.isFinite(ride.totalCustomers)) return null;

    const samples = throughputSamples.get(ride.id) || [];
    const previous = samples[samples.length - 1];
    if (previous && ride.totalCustomers < previous.customers) {
        samples.length = 0;
    }
    samples.push({ customers: ride.totalCustomers, tick: currentTick });
    while (samples.length > 1 &&
        currentTick - samples[0].tick > THROUGHPUT_SAMPLE_WINDOW_TICKS) {
        samples.shift();
    }
    throughputSamples.set(ride.id, samples);
    if (samples.length < THROUGHPUT_REQUIRED_SAMPLES) return null;

    const first = samples[0];
    const elapsedTicks = currentTick - first.tick;
    if (elapsedTicks <= 0) return null;
    return {
        value: (ride.totalCustomers - first.customers) * 144000 / elapsedTicks
    };
}

function notifyLowThroughput(ride, throughput, threshold, currentTick, cooldownTicks) {
    // Stop ignored rides from notifying
    if (!isStallOrFacility(ride) && isIgnoredRide(ride)) return false;
    if (lastNotificationTick !== undefined &&
        currentTick - lastNotificationTick < settings.notificationCooldownSeconds * 40) return false;
    const cooldownKey = `throughput:${getCooldownKey(ride)}`;
    const lastNotified = cooldowns.get(cooldownKey);
    if (lastNotified !== undefined && currentTick - lastNotified < cooldownTicks) return false;

    cooldowns.set(cooldownKey, currentTick);
    lastNotificationTick = currentTick;
    park.postMessage({
        type: "attraction",
        subject: ride.id,
        text: `${ride.name} is estimated at ${Math.round(throughput.value)} customers/hour, below the threshold of ${threshold}`
    });
    return true;
}

function checkThroughput(currentTick, cooldownTicks) {
    // Sample every ride, then alert only after enough data is available
    if (!map.rides) return;

    for (let i = 0; i < map.rides.length; i++) {
        const ride = map.rides[i];
        if (!ride) continue;

        const isStall = isStallOrFacility(ride);
        if (!isStall && isIgnoredRide(ride)) {
            throughputSamples.delete(ride.id);
            continue;
        }
        const category = getRideCategory(ride);
        const enabled = isStall ? settings.stallThroughput : settings.rideThroughput;
        if (!enabled) {
            getCustomersPerHour(ride, currentTick);
            continue;
        }

        const throughput = getCustomersPerHour(ride, currentTick);
        if (throughput === null) continue;
        const minimumAge = isStall ? settings.minStallAgeMonths : settings.minRideAgeMonths;
        if (typeof ride.age !== "number" || ride.age < minimumAge) continue;
        const threshold = isStall
            ? settings.stallThroughputThreshold
            : settings[`${category}ThroughputThreshold`];
        if (throughput.value < threshold) {
            notifyLowThroughput(ride, throughput, threshold, currentTick, cooldownTicks);
        }
    }
}

function openSettings() {
    ui.openWindow({
        classification: "low-throughput-notifier-settings",
        title: "Ride/Stall Throughput & Price Notifier",
        width: 330,
        height: 410,
        widgets: [
            {
                type: "label",
                x: 10,
                y: 20,
                width: 210,
                height: 14,
                text: "Ride / stall cooldown (minutes)",
                tooltip: "How long to wait before alerting about the same ride or stall again. Maximum: 10 minutes."
            },
            {
                type: "textbox",
                x: 225,
                y: 18,
                width: 95,
                height: 16,
                text: String(settings.cooldownMinutes),
                maxLength: 4,
                tooltip: "How long to wait before alerting about the same ride or stall again. Maximum: 10 minutes.",
                onChange: value => saveSetting("cooldownMinutes", value)
            },
            {
                type: "label",
                x: 10,
                y: 54,
                width: 210,
                height: 14,
                text: "Ride: min thoughts required",
                tooltip: "Minimum number of different guests who must think a ride is good value or too expensive before notifying. Maximum: 10 guests."
            },
            {
                type: "textbox",
                x: 225,
                y: 46,
                width: 95,
                height: 16,
                text: String(settings.thresholdRideGuests),
                maxLength: 4,
                tooltip: "Minimum number of different guests who must think a ride is good value or too expensive before notifying. Maximum: 10 guests.",
                onChange: value => saveSetting("thresholdRideGuests", value)
            },
            {
                type: "label",
                x: 10,
                y: 76,
                width: 210,
                height: 14,
                text: "Stall: min thoughts required",
                tooltip: "Minimum number of different guests who must think a stall item is good value or too expensive before notifying. Maximum: 10 guests."
            },
            {
                type: "textbox",
                x: 225,
                y: 74,
                width: 95,
                height: 16,
                text: String(settings.thresholdStallGuests),
                maxLength: 4,
                tooltip: "Minimum number of different guests who must think a stall item is good value or too expensive before notifying. Maximum: 10 guests.",
                onChange: value => saveSetting("thresholdStallGuests", value)
            },
            {
                type: "label",
                x: 10,
                y: 104,
                width: 210,
                height: 14,
                text: "Notification cooldown (seconds)",
                tooltip: "Minimum time between any two notifications. Maximum: 120 seconds."
            },
            {
                type: "textbox",
                x: 225,
                y: 102,
                width: 95,
                height: 16,
                text: String(settings.notificationCooldownSeconds),
                maxLength: 3,
                tooltip: "Minimum time between any two notifications. Maximum: 120 seconds.",
                onChange: value => saveNotificationCooldownSeconds(value)
            },
            {
                type: "checkbox",
                x: 10,
                y: 134,
                width: 155,
                height: 18,
                text: "Rides: good value",
                tooltip: "Enable notifications when guests think a ride is good value.",
                isChecked: settings.notifyGoodValueRides,
                onChange: value => saveToggle("notifyGoodValueRides", value)
            },
            {
                type: "checkbox",
                x: 170,
                y: 134,
                width: 150,
                height: 18,
                text: "Stalls: good value",
                tooltip: "Enable notifications when guests think a stall item is good value.",
                isChecked: settings.notifyGoodValueStalls,
                onChange: value => saveToggle("notifyGoodValueStalls", value)
            },
            {
                type: "checkbox",
                x: 10,
                y: 158,
                width: 155,
                height: 18,
                text: "Rides: too expensive",
                tooltip: "Enable notifications when guests think a ride is too expensive.",
                isChecked: settings.notifyExpensiveRides,
                onChange: value => saveToggle("notifyExpensiveRides", value)
            },
            {
                type: "checkbox",
                x: 170,
                y: 158,
                width: 150,
                height: 18,
                text: "Stalls: too expensive",
                tooltip: "Enable notifications when guests think a stall item is too expensive.",
                isChecked: settings.notifyExpensiveStalls,
                onChange: value => saveToggle("notifyExpensiveStalls", value)
            },
            {
                type: "checkbox",
                x: 10,
                y: 182,
                width: 310,
                height: 18,
                text: "Ignore information kiosks",
                tooltip: "Do not notify about map or umbrella value thoughts from information kiosks.",
                isChecked: settings.ignoreInformationKiosks,
                onChange: value => saveToggle("ignoreInformationKiosks", value)
            },
            {
                type: "label",
                x: 10,
                y: 208,
                width: 310,
                height: 14,
                text: "{WHITE}Low throughput notifications"
            },
            {
                type: "checkbox",
                x: 10,
                y: 232,
                width: 155,
                height: 18,
                text: "Stall throughput",
                tooltip: "Notify when a stall is serving fewer customers per hour than its threshold.",
                isChecked: settings.stallThroughput,
                onChange: value => saveToggle("stallThroughput", value)
            },
            {
                type: "textbox",
                x: 225,
                y: 230,
                width: 95,
                height: 16,
                text: String(settings.stallThroughputThreshold),
                maxLength: 5,
                tooltip: "Stall customers-per-hour threshold. Default: 45.",
                onChange: value => saveThroughputThreshold("stallThroughputThreshold", value)
            },
            {
                type: "checkbox",
                x: 10,
                y: 256,
                width: 155,
                height: 18,
                text: "Ride throughput",
                tooltip: "Notify when a ride is serving fewer customers per hour than its category threshold.",
                isChecked: settings.rideThroughput,
                onChange: value => saveToggle("rideThroughput", value)
            },
            {
                type: "label",
                x: 10,
                y: 282,
                width: 310,
                height: 14,
                text: "Ride customers per hour thresholds"
            },
            ...THROUGHPUT_CATEGORIES.reduce((widgets, category, index) => {
                const x = index % 2 === 0 ? 10 : 170;
                const y = 304 + Math.floor(index / 2) * 24;
                widgets.push({
                    type: "label",
                    x,
                    y: y + 2,
                    width: 88,
                    height: 14,
                    text: category.label
                });
                widgets.push({
                    type: "textbox",
                    x: x + 90,
                    y,
                    width: 60,
                    height: 16,
                    text: String(settings[`${category.key}ThroughputThreshold`]),
                    maxLength: 5,
                    tooltip: `${category.label} ride customers-per-hour threshold. Default: 45.`,
                    onChange: value => saveThroughputThreshold(`${category.key}ThroughputThreshold`, value)
                });
                return widgets;
            }, []),
            {
                type: "label",
                x: 10,
                y: 376,
                width: 310,
                height: 14,
                text: "Tip: Hover over settings for more information."
            }
        ]
    });
}

function openTabbedSettings() {
    const tabContentOffset = 48;
    const globalWidgets = [
        {
            type: "label", x: 10, y: 18, width: 220, height: 14,
            text: "Ride / stall cooldown (minutes)",
            tooltip: "How long to wait before the same ride or stall can notify again. Range: 1-30 minutes."
        },
        createNumericField(235, 16, 75, "cooldownMinutes",
            "How long to wait before the same ride or stall can notify again. Range: 1-30 minutes.",
            value => saveSetting("cooldownMinutes", value)),
        {
            type: "label", x: 10, y: 42, width: 220, height: 14,
            text: "Notification cooldown (seconds)",
            tooltip: "Minimum time between any notifications. Range: 5-300 seconds."
        },
        createNumericField(235, 40, 75, "notificationCooldownSeconds",
            "Minimum time between any notifications. Range: 5-300 seconds.",
            value => saveNotificationCooldownSeconds(value)),
    ];

    const throughputWidgets = [
        createToggle(10, 18, 170, "stallThroughput", "Stall throughput",
            "Enables throughput notifications for stalls; gathers 10 samples every 10 minutes to calculate true customers per hour value"),
        {
            type: "label", x: 170, y: 20, width: 100, height: 14, text: "Stall Threshold"
        },
        createNumericField(270, 16, 50, "stallThroughputThreshold",
            "Stall customers-per-hour threshold. Default: 45.",
            value => saveThroughputThreshold("stallThroughputThreshold", value)),
        {
            type: "label", x: 10, y: 46, width: 150, height: 14,
            text: "Minimum ride age (months)"
        },
        createNumericField(170, 44, 70, "minRideAgeMonths",
            "Minimum ride age before throughput notifications. Default: 2 months. Minimum 0.",
            value => saveAgeMonths("minRideAgeMonths", value)),
        {
            type: "label", x: 10, y: 70, width: 150, height: 14,
            text: "Minimum stall age (months)"
        },
        createNumericField(170, 68, 70, "minStallAgeMonths",
            "Minimum stall age before throughput notifications. Default: 1 months. Minimum 0.",
            value => saveAgeMonths("minStallAgeMonths", value))
    ];

    const rideThresholdWidgets = [];
    rideThresholdWidgets.push(createToggle(10, 18, 170, "rideThroughput", "Ride throughput",
        "Enables throughput notifications for rides; gathers 10 samples every 10 minutes to calculate true customers per hour value"));
    THROUGHPUT_CATEGORIES.forEach((category, index) => {
        const y = 42 + index * 20;
        rideThresholdWidgets.push(
            { type: "label", x: 10, y: y + 2, width: 150, height: 14, text: category.label },
            createNumericField(170, y, 70, `${category.key}ThroughputThreshold`,
                `${category.label} ride customers-per-hour threshold. Default: ${category.defaultThreshold}.`,
                value => saveThroughputThreshold(`${category.key}ThroughputThreshold`, value))
        );
    });
    IGNORED_RIDE_TYPES.forEach((rideType, index) => {
        const column = index % 2;
        const row = Math.floor(index / 2);
        const settingName = `ignore${rideType.key[0].toUpperCase()}${rideType.key.slice(1)}`;
        rideThresholdWidgets.push(createToggle(
            column === 0 ? 10 : 165,
            166 + row * 20,
            150,
            settingName,
            `Ignore: ${rideType.label}`,
            `Ignore ${rideType.label} for ride throughput notifications.`
        ));
    });

    const priceWidgets = [
        {
            type: "label", x: 10, y: 18, width: 220, height: 14,
            text: "Ride: min thoughts required",
            tooltip: "Different guests required before a ride price notification. Maximum: 10."
        },
        createNumericField(235, 16, 75, "thresholdRideGuests",
            "Different guests required before a ride price notification. Maximum: 10.",
            value => saveSetting("thresholdRideGuests", value)),
        {
            type: "label", x: 10, y: 46, width: 220, height: 14,
            text: "Stall: min thoughts required",
            tooltip: "Different guests required before a stall price notification. Maximum: 10."
        },
        createNumericField(235, 44, 75, "thresholdStallGuests",
            "Different guests required before a stall price notification. Maximum: 10.",
            value => saveSetting("thresholdStallGuests", value))
    ];

    [
        ["notifyGoodValueRides", "Rides: good value", "Enable good-value notifications for rides."],
        ["notifyGoodValueStalls", "Stalls: good value", "Enable good-value notifications for stalls."],
        ["notifyExpensiveRides", "Rides: too expensive", "Enable too-expensive notifications for rides."],
        ["notifyExpensiveStalls", "Stalls: too expensive", "Enable too-expensive notifications for stalls."]
    ].forEach((option, index) => {
        priceWidgets.push(createToggle(
            index % 2 === 0 ? 10 : 170,
            66 + Math.floor(index / 2) * 20,
            155,
            option[0],
            option[1],
            option[2]
        ));
    });

    priceWidgets.push(createToggle(
        10,
        108,
        300,
        "ignoreInformationKiosks",
        "Ignore information kiosks",
        "Do not notify about map or umbrella value thoughts from information kiosks."
    ));

    const tabs = [
        { image: GLOBAL_TAB_ICON, widgets: [] },
        { image: THROUGHPUT_TAB_ICON, widgets: [] },
        { image: PRICE_TAB_ICON, widgets: [] }
    ];
    const addGroup = (tabIndex, widgets, title, height, y) => {
        tabs[tabIndex].widgets.push({
            type: "groupbox",
            x: 5,
            y: y + 8,
            width: 320,
            height,
            text: title
        });
        widgets.forEach(widget => {
            widget.y += y;
            tabs[tabIndex].widgets.push(widget);
        });
    };

    addGroup(0, globalWidgets, "Global settings", 114, 0);
    addGroup(1, throughputWidgets, "Throughput Notifier", 100, 0);
    addGroup(1, rideThresholdWidgets, "Ride Thresholds", 290, 112);
    addGroup(2, priceWidgets, "Price Notifier", 135, 0);

    tabs[0].widgets.push({
        type: "label", x: 10, y: 111, width: 300, height: 14,
        text: "Tip: Hover over settings for more information."
    });
    tabs[1].widgets.push({
        type: "label", x: 10, y: 398, width: 300, height: 14,
        text: "Tip: Hover over settings for more information."
    });
    tabs[2].widgets.push({
        type: "label", x: 10, y: 132, width: 300, height: 14,
        text: "Tip: Hover over settings for more information."
    });

    tabs.forEach(tab => {
        tab.widgets.forEach(widget => {
            widget.y += widget.type === "groupbox" ? tabContentOffset : tabContentOffset + 12;
        });
    });

    const windowClassification = "ride-price-complaint-notifier-settings";
    ui.openWindow({
        classification: windowClassification,
        title: "Ride/Stall Throughput & Price Notifier",
        width: 330,
        height: 184,
        tabs,
        tabIndex: 0,
        onTabChange: () => {
            const window = ui.getWindow(windowClassification);
            if (!window) return;
            syncVisibleToggleWidgets(window);
            window.height = [184, 470, 206][window.tabIndex] || 184;
        },
        onUpdate: () => {
            const window = ui.getWindow(windowClassification);
            if (window) syncVisibleToggleWidgets(window);
        }
    });
}

function main() {
    settings = loadSettings();

    if (typeof ui !== "undefined") {
        ui.registerMenuItem("Ride/Stall Throughput & Price Notifier Settings", openTabbedSettings);
    }

    // Check traffic and guest thoughts once a minute
    context.setInterval(() => {
        try {
            const currentTick = date.ticksElapsed;
            const scanCooldownTicks = THROUGHPUT_SCAN_INTERVAL_SECONDS * 40;
            if (lastScanTick !== undefined && currentTick - lastScanTick < scanCooldownTicks) return;
            lastScanTick = currentTick;

            const cooldownTicks = settings.cooldownMinutes * 60 * 40;
            checkThroughput(currentTick, cooldownTicks);
            const guests = map.getAllEntities("guest");
            if (!guests || guests.length === 0) return;

            // Count each guest once per ride and thought type
            const thoughtCounts = new Map();

            for (let i = 0; i < guests.length; i++) {
                const guest = guests[i];
                if (!guest || !guest.thoughts) continue;

                for (let j = 0; j < guest.thoughts.length; j++) {
                    const thought = guest.thoughts[j];
                    if (!thought) continue;

                    const thoughtType = getPriceThoughtKind(thought.type);
                    if (!thoughtType || thought.freshness !== 1 || typeof thought.item !== "number") continue;
                    const rideId = thought.item;
                    const ride = map.getRide(rideId);
                    if (!ride) continue;
                    if (!isStallOrFacility(ride) && isIgnoredRide(ride)) continue;
                    if (shouldIgnoreMapUmbrellaThought(ride, thought.type)) continue;
                    const isStall = isStallOrFacility(ride);
                    if (thoughtType === "good_value") {
                        if (isStall && !settings.notifyGoodValueStalls) continue;
                        if (!isStall && !settings.notifyGoodValueRides) continue;
                    }
                    if (thoughtType === "expensive") {
                        if (isStall && !settings.notifyExpensiveStalls) continue;
                        if (!isStall && !settings.notifyExpensiveRides) continue;
                    }

                    const cooldownKey = getCooldownKey(ride);
                    const lastNotified = cooldowns.get(cooldownKey);
                    if (lastNotified !== undefined && currentTick - lastNotified < cooldownTicks) continue;

                    const itemName = isShopItemThought(thought.type)
                        ? getShopItemName(thought.type)
                        : null;
                    const groupKey = itemName ? `${rideId}:${itemName}` : String(rideId);
                    if (!thoughtCounts.has(thoughtType)) {
                        thoughtCounts.set(thoughtType, new Map());
                    }

                    // Add unique guest ID to prevent duplicate counts from the same guest
                    const rides = thoughtCounts.get(thoughtType);
                    if (!rides.has(groupKey)) {
                        rides.set(groupKey, { rideId, itemName, guests: new Set() });
                    }
                    rides.get(groupKey).guests.add(guest.id);
                }
            }

            // Send at most one value alert per scan.
            let notificationSent = false;
            thoughtCounts.forEach((rides, thoughtType) => {
                if (notificationSent) return;
                rides.forEach(thoughtData => {
                    if (notificationSent) return;

                    const rideId = thoughtData.rideId;
                    const ride = map.getRide(rideId);
                    if (!ride) return;
                    if (!isStallOrFacility(ride) && isIgnoredRide(ride)) return;
                    if (shouldIgnoreMapUmbrellaThought(ride, thoughtData.itemName)) return;
                    if (lastNotificationTick !== undefined &&
                        currentTick - lastNotificationTick < settings.notificationCooldownSeconds * 40) return;
                    const requiredGuests = isStallOrFacility(ride)
                        ? settings.thresholdStallGuests
                        : settings.thresholdRideGuests;
                    if (thoughtData.guests.size < requiredGuests) return;

                    const cooldownKey = getCooldownKey(ride);
                    const lastNotified = cooldowns.get(cooldownKey);
                    if (lastNotified !== undefined && currentTick - lastNotified < cooldownTicks) return;

                    cooldowns.set(cooldownKey, currentTick);
                    lastNotificationTick = currentTick;
                    const text = thoughtData.itemName
                        ? `${thoughtType === "good_value" ? "{YELLOW}" : "{PALEGOLD}"}Guests think the ${thoughtData.itemName} from ${ride.name} is ${thoughtType === "good_value" ? "good value" : "too expensive"}.`
                        : thoughtType === "good_value"
                            ? `{YELLOW}Guests think ${ride.name} is good value.`
                            : `{PALEGOLD}Guests think ${ride.name} is too expensive.`;

                    park.postMessage({
                        type: "attraction",
                        subject: ride.id,
                        text
                    });
                    notificationSent = true;
                });
            });

        } catch (error) {
            console.log(`[Price Alert Plugin Error]: ${error}`);
        }
    }, 1000);
}

registerPlugin({
    name: "Ride/Stall Throughput & Price Notifier",
    version: "1.0",
    apiVersion: 74,
    authors: ["gabrielchcosta"],
    type: "local",
    licence: "MIT",
    main: main
});