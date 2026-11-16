// Shared vocabularies from the RoomCare class diagram (RoomStatus, TaskStatus, WorkOrderStatus, ...).

export const ROLES = ["housekeeper", "technician", "admin"];
// Roles a new user may pick on the public registration form; elevated roles are granted by the System Admin.
export const SELF_REGISTER_ROLES = ["housekeeper", "technician"];
export const ROLE_LABELS = {
  housekeeper: "Housekeeper",
  technician: "Maintenance Technician",
  admin: "System Admin",
};

export const RoomStatus = {
  VACANT_DIRTY: "VACANT_DIRTY",
  CLEANING: "CLEANING",
  VACANT_CLEAN: "VACANT_CLEAN",
  INSPECTED: "INSPECTED",
  OCCUPIED: "OCCUPIED",
  OUT_OF_ORDER: "OUT_OF_ORDER",
};
export const ROOM_STATUSES = Object.values(RoomStatus);
// Statuses a System Admin may set by hand. Occupied comes only from check-in, Out of Order only from a work order.
export const ADMIN_ROOM_STATUSES = ROOM_STATUSES.filter((s) => ![RoomStatus.OCCUPIED, RoomStatus.OUT_OF_ORDER].includes(s));
export const ROOM_TYPES = ["Standard Twin", "Deluxe King", "Family Room", "Junior Suite"];

export const TaskStatus = {
  PENDING: "PENDING",
  IN_PROGRESS: "IN_PROGRESS",
  DONE: "DONE",
  INSPECTED: "INSPECTED",
};
export const TASK_STATUSES = Object.values(TaskStatus);
export const ACTIVE_TASK_STATUSES = [TaskStatus.PENDING, TaskStatus.IN_PROGRESS];
// Where a cleaning task came from: created by an admin, or automatically from a PMS RoomVacated event.
export const TASK_SOURCES = ["MANUAL", "PMS"];

// Housekeeping statuses shown to people, mapped onto the stored task status (no schema change):
// PENDING without a housekeeper = Pending Cleaning, PENDING with one = Assigned, IN_PROGRESS = Cleaning In Progress,
// DONE = Cleaning Completed (and pending verification by inspection), INSPECTED = Verified.
export const housekeepingStatus = (task) => {
  if (!task) return "";
  switch (task.status) {
    case TaskStatus.PENDING: return task.housekeeperId ? "Assigned" : "Pending Cleaning";
    case TaskStatus.IN_PROGRESS: return "Cleaning In Progress";
    case TaskStatus.DONE: return "Cleaning Completed";
    case TaskStatus.INSPECTED: return "Verified";
    default: return task.status;
  }
};
export const TASK_TYPES = {
  CHECKOUT_CLEAN: "Checkout clean",
  STAYOVER: "Stayover service",
  TOUCH_UP: "Touch-up",
  DEEP_CLEAN: "Deep clean",
};

export const WorkOrderStatus = {
  OPEN: "OPEN",
  ASSIGNED: "ASSIGNED",
  IN_PROGRESS: "IN_PROGRESS",
  ON_HOLD: "ON_HOLD",
  RESOLVED: "RESOLVED",
  CLOSED: "CLOSED",
  CANCELLED: "CANCELLED",
};
export const WO_STATUSES = Object.values(WorkOrderStatus);
// Work orders that still block a room from being inspected and released.
export const ACTIVE_WO_STATUSES = [
  WorkOrderStatus.OPEN,
  WorkOrderStatus.ASSIGNED,
  WorkOrderStatus.IN_PROGRESS,
  WorkOrderStatus.ON_HOLD,
];
export const WO_CATEGORIES = ["Air-conditioning", "Plumbing", "Electrical", "Furniture", "Appliance", "Carpentry", "Painting", "Other"];

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
// Hours from report to resolution before a work order counts as overdue.
export const SLA_HOURS = { URGENT: 2, HIGH: 4, MEDIUM: 24, LOW: 72 };

export const CHANNELS = ["SMS", "EMAIL", "PUSH", "IN_APP"];

// External integrations (see services/pmsIntegrationService.js and services/hrExportService.js).
export const INTEGRATION_SYSTEMS = ["PMS", "HR"];
export const INTEGRATION_DIRECTIONS = ["IN", "OUT"];
// IN:  PROCESSED | REJECTED          OUT: PENDING → SENDING → SENT, or FAILED after the last retry
export const IntegrationStatus = {
  PROCESSED: "PROCESSED",
  REJECTED: "REJECTED",
  PENDING: "PENDING",
  SENDING: "SENDING",
  SENT: "SENT",
  FAILED: "FAILED",
};
export const INTEGRATION_STATUSES = Object.values(IntegrationStatus);

export const InspectionResult = { PASS: "PASS", FAIL: "FAIL" };
export const INSPECTION_CHECKLIST = [
  { key: "bed", label: "Bed made, linen and towels fresh", kind: "cleaning" },
  { key: "bathroom", label: "Bathroom cleaned and sanitized", kind: "cleaning" },
  { key: "floor", label: "Floor vacuumed / mopped, trash removed", kind: "cleaning" },
  { key: "amenities", label: "Amenities and minibar restocked", kind: "cleaning" },
  { key: "fixtures", label: "Aircon, lights, TV and fixtures working", kind: "maintenance" },
  { key: "repair", label: "Reported repairs completed, no damage", kind: "maintenance" },
];
