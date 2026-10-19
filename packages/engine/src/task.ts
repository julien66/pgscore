import type { LatLon } from "./geo.js";

/** Rôle d'une zone de contrôle dans la manche. */
export type TurnpointRole = "takeoff" | "sss" | "turnpoint" | "ess" | "goal";

export interface Waypoint extends LatLon {
  name: string;
  description?: string;
  /** Altitude de la balise, en mètres AMSL. */
  altitude?: number;
}

export interface CylinderZone {
  kind: "cylinder";
  waypoint: Waypoint;
  /** Rayon en mètres. */
  radius: number;
  /** Limites d'altitude optionnelles (S7F 2026, 6.2.1), en mètres AMSL. */
  lowerLimit?: number;
  upperLimit?: number;
}

export interface GoalLineZone {
  kind: "goal-line";
  waypoint: Waypoint;
  /** Longueur totale de la ligne, en mètres (S7F 6.2.3.1). */
  length: number;
}

export type ControlZone = CylinderZone | GoalLineZone;

export interface TaskTurnpoint {
  role: TurnpointRole;
  zone: ControlZone;
}

export type TaskType = "race" | "time-trial";

/**
 * Manche telle que le moteur la contrôle. Les heures sont des chaînes "HH:MM:SS"
 * en UTC (comme dans .xctsk) ; la date de la manche est portée à part.
 */
export interface Task {
  type: TaskType;
  turnpoints: TaskTurnpoint[];
  /** Heures des portes de départ, en UTC ("HH:MM:SS"). */
  startGates: string[];
  takeoffOpen?: string;
  takeoffClose?: string;
  deadline?: string;
  /** Manche arrêtée (13.4.1) : heure de la première annonce de l'arrêt, en UTC ("HH:MM:SS"). */
  stopAnnouncement?: string;
  /** Score-back en secondes (13.4.1) : 300 en parapente (par défaut), 900 en delta. */
  scoreBackTime?: number;
  /** Indication d'origine (enter/exit) gardée pour l'affichage : le S7F 2026 ne l'utilise plus. */
  startDirection?: "enter" | "exit";
  /** Modèle terrestre déclaré par le fichier source ; le contrôle utilise toujours WGS84. */
  sourceEarthModel?: "WGS84" | "FAI_SPHERE";
}
