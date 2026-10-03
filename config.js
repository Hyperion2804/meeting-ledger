// ============================================================
//  EDIT THIS FILE — it is the only one you need to change.
//  Everything else works as-is.
// ============================================================

// 1. Your organisation's email domain. Only these addresses can sign in.
export const ORG_DOMAIN = "hyperioncapital.in";

// 2. Your Firebase project's config (from Firebase Console -> Project settings).
export const firebaseConfig = {
  apiKey: "AIzaSyDyl73p3CgKDOiTnLfxuYwE_oIHyyJmiyQ",
  authDomain: "meeting-ledger.firebaseapp.com",
  projectId: "meeting-ledger",
  storageBucket: "meeting-ledger.firebasestorage.app",
  messagingSenderId: "520159635970",
  appId: "1:520159635970:web:54ade9e2e65671f461151b"
};

// 3. Office timings — one schedule for the whole firm (RMs, Team Leads,
//    Admins, Superadmins). Holidays are added in Meeting Ledger → Holidays.
//    If this ever changes, change it in BOTH apps' config.js.
export const OFFICE = {
  start: "09:30",            // 24-hour HH:MM
  end:   "18:30",
  offSaturdays: [2, 4]       // 2nd and 4th Saturday of each month are off; Sundays always off
};

// 4. Dropdown values. These match the Excel sheets exactly.
export const OPTIONS = {
  personType:  ["Wealth Manager", "Channel Partner", "Investor"],
  meetingType: ["First", "Follow-up"],
  mode:        ["Offline", "Online", "Call"],
  source:      ["Direct", "LinkedIn", "Reference", "Wealth Manager", "Channel Partner", "Cold Call", "Existing Client", "Event / Seminar", "Other"],
  result:      ["Interested", "To be followed up", "Not Interested"],
  shared:      ["Yes", "Not yet", "No"],
  progressed:  ["Yes", "Pending"],
  notInterestedReason: [
    "Not Convinced",
    "Need to see Fund Performance",
    "Investment Manager does not give confidence",
    "High Charges",
    "Only invest in renowned funds",
    "Not Interested in Private Markets"
  ],
  leadStatus: ["Meeting Done", "Pending"],
  contactMode: ["New", "Existing"]
};
