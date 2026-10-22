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
  /** Manche arrêtée : finesse du bonus d'altitude (13.4.6), 2,5 par défaut ; FS la règle dans sa formule (bonus_gr). */
  bonusGlideRatio?: number;
  /**
   * Elevated goal (6.2.3.2, 13.1) : hauteur, en mètres au-dessus de l'altitude publiée du goal, sous laquelle
   * les points de temps sont réduits (300 m par défaut dans le S7F). Absent : goal ordinaire.
   */
  elevatedGoal?: number;
  /**
   * Tolérance relative des cylindres (9.1.1), en part du rayon : 0 en S7F 2026 (seuls les 5 m absolus comptent).
   * Certaines compétitions gardent l'ancienne valeur, 0,001 (0,1 %).
   */
  cylinderTolerance?: number;
  /**
   * Orientation du goal en ligne. "route" (par défaut, S7F 2026 6.2.3.1 et PWCA 13.5) : perpendiculaire à la
   * route optimisée qui y arrive. "previousCentre" (S7F 2024) : perpendiculaire à la direction du centre de la
   * dernière balise de centre différent, prise en degrés de latitude et de longitude sans correction, comme les
   * résultats publiés de la German Open 2026 (manche 1).
   */
  goalLineOrientation?: "route" | "previousCentre";
  /** Indication d'origine (enter/exit) gardée pour l'affichage : le S7F 2026 ne l'utilise plus. */
  startDirection?: "enter" | "exit";
  /** Modèle terrestre déclaré par le fichier source ; le contrôle utilise toujours WGS84. */
  sourceEarthModel?: "WGS84" | "FAI_SPHERE";
}

/** "HH:MM:SS" en secondes. */
export function hmsSeconds(hms: string): number {
  const [h, m, s] = hms.split(":").map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
}

/**
 * Heure d'une manche en secondes depuis 0 h UTC du jour du vol. Les heures UTC d'une manche peuvent
 * passer minuit : aux États-Unis, porte à 20:00 et deadline à 01:30 UTC (le lendemain). Une heure qui
 * tombe plus de 6 h avant l'ouverture du décollage (ou, à défaut, la première porte) est donc celle du lendemain.
 */
export function taskSeconds(task: Pick<Task, "startGates" | "takeoffOpen">, hms: string): number {
  const t = hmsSeconds(hms);
  const ref = task.takeoffOpen ? hmsSeconds(task.takeoffOpen) : task.startGates.length ? Math.min(...task.startGates.map(hmsSeconds)) : null;
  return ref !== null && ref - t > 6 * 3600 ? t + 86_400 : t;
}

/** Instant (ms) d'une heure de la manche, connaissant l'instant de la première porte. */
export function taskTimeFromGate(task: Pick<Task, "startGates" | "takeoffOpen">, hms: string, firstGateMs: number): number {
  const gate = Math.min(...task.startGates.map((g) => taskSeconds(task, g)));
  return firstGateMs + (taskSeconds(task, hms) - (Number.isFinite(gate) ? gate : taskSeconds(task, hms))) * 1000;
}
