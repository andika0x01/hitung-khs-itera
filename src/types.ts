export interface CourseRow {
  id: string;
  name: string;
  sks: number;
  grade: string; // A, AB, B, BC, C, D, E, or empty
}

export interface Scenario {
  id: string;
  name: string;
  semestersData: Record<number, CourseRow[]>;
}

export const GRADE_WEIGHTS: Record<string, number> = {
  A: 4,
  AB: 3.5,
  B: 3,
  BC: 2.5,
  C: 2,
  D: 1,
  E: 0,
};

