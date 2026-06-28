import { useState, useEffect, useRef } from "react";
import type { CourseRow, Scenario } from "./types";
import { GRADE_WEIGHTS } from "./types";
import * as pdfjsLib from "pdfjs-dist";

// @ts-expect-error: PDF worker import path is not resolved statically by TypeScript
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

interface ParsedCourse {
  id: string;
  code: string;
  name: string;
  sks: number;
  grade: string;
  semester: number;
}

interface StudentMetadata {
  name: string;
  nim: string;
  faculty: string;
  studyProgram: string;
  totalCredit: string;
  ipk: string;
}

// Helper to generate a unique ID
const generateId = () => Math.random().toString(36).substring(2, 9);

// Default initial rows
const createEmptyRow = (defaultSks = 3): CourseRow => ({
  id: generateId(),
  name: "",
  sks: defaultSks,
  grade: "",
});

// Helper to estimate semester from course code or list index
const estimateSemester = (code: string, index: number): number => {
  let numericPart = "";
  if (code.includes("-")) {
    numericPart = code.split("-")[1];
  } else {
    const match = code.match(/\d+/);
    if (match) {
      numericPart = match[0];
    }
  }

  if (numericPart) {
    if (numericPart.length === 4) {
      const year = parseInt(numericPart[0]);
      const semType = parseInt(numericPart[1]);
      if (year >= 1 && year <= 4 && (semType === 1 || semType === 2)) {
        return (year - 1) * 2 + semType;
      }
    } else if (numericPart.length === 5) {
      const year = parseInt(numericPart[0]);
      const semType = parseInt(numericPart[1]);
      if (year >= 1 && year <= 4) {
        if (semType === 1 || semType === 2) {
          return (year - 1) * 2 + semType;
        } else if (semType === 0) {
          return (year - 1) * 2 + 1; // default to odd semester of that year
        }
      }
    }
  }

  // Fallback by order of appearance in transcript
  if (index <= 8) return 1;
  if (index <= 19) return 2;
  if (index <= 24) return 3;
  if (index <= 31) return 4;
  if (index <= 36) return 5;
  if (index <= 40) return 6;
  return 7;
};

// Main PDF text extraction and parsing parser function
const parsePdfFile = async (file: File): Promise<{ metadata: StudentMetadata; courses: ParsedCourse[] }> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;

        let fullText = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          interface TextItem {
            str: string;
            transform: number[];
          }
          const items = textContent.items as unknown as TextItem[];

          // Reconstruct lines by Y-coordinate
          const linesMap: Record<number, { text: string; x: number; y: number }[]> = {};
          items.forEach((item) => {
            if (!item.str || item.str.trim() === "") return;
            const x = item.transform[4];
            const y = item.transform[5];

            let foundGroup = false;
            const threshold = 4;
            for (const groupYStr of Object.keys(linesMap)) {
              const groupY = parseFloat(groupYStr);
              if (Math.abs(groupY - y) < threshold) {
                linesMap[groupY].push({ text: item.str, x, y });
                foundGroup = true;
                break;
              }
            }
            if (!foundGroup) {
              linesMap[y] = [{ text: item.str, x, y }];
            }
          });

          const sortedYs = Object.keys(linesMap)
            .map(parseFloat)
            .sort((a, b) => b - a);

          const lines: string[] = [];
          sortedYs.forEach((y) => {
            const rowItems = linesMap[y].sort((a, b) => a.x - b.x);
            const lineText = rowItems.map((item) => item.text).join(" ");
            lines.push(lineText);
          });

          fullText += lines.join("\n") + "\n";
        }

        // Parse metadata
        const name = fullText.match(/Name\s*:\s*([^\n\r]+)/i)?.[1]?.trim() || "";
        const nim = fullText.match(/NIM\s*:\s*([^\n\r]+)/i)?.[1]?.trim() || "";
        const faculty = fullText.match(/Faculty\s*:\s*([^\n\r]+)/i)?.[1]?.trim() || "";
        const studyProgram = fullText.match(/Study\s+Program\s*:\s*([^\n\r]+)/i)?.[1]?.trim() || "";
        const totalCredit = fullText.match(/Total\s+Credit\s*:\s*(\d+)/i)?.[1]?.trim() || "";
        const ipk = fullText.match(/Grade\s+Point\s*\(GP\)\s*:\s*([\d.]+)/i)?.[1]?.trim() || "";

        const metadata: StudentMetadata = { name, nim, faculty, studyProgram, totalCredit, ipk };

        // Run regex for courses
        const regex = /\b(\d+)\s+([A-Z]{2,4}\d+(?:-\d+)?)\s+(.+?)\s+(\d+)\s+([A-Z]{1,2})\b/g;
        const matches = [...fullText.matchAll(regex)];

        const courses: ParsedCourse[] = matches.map((m) => {
          const index = parseInt(m[1]);
          const code = m[2];
          const name = m[3].trim();
          const sks = parseInt(m[4]);
          const grade = m[5];

          const semester = estimateSemester(code, index);

          return {
            id: Math.random().toString(36).substring(2, 9),
            code,
            name,
            sks,
            grade,
            semester,
          };
        });

        resolve({ metadata, courses });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsArrayBuffer(file);
  });
};

function App() {
  const [scenarios, setScenarios] = useState<Scenario[]>(() => {
    try {
      const stored = localStorage.getItem("itera_khs_scenarios");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (e) {
      console.error("Failed to parse scenarios from localStorage", e);
    }

    // Migration from legacy semestersData
    let initialSemestersData: Record<number, CourseRow[]> | null = null;
    try {
      const stored = localStorage.getItem("itera_khs_semesters");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === "object") {
          initialSemestersData = parsed;
        }
      }
    } catch (e) {
      console.error("Failed to parse semesters from localStorage", e);
    }

    // Legacy migration (older row structure)
    if (!initialSemestersData) {
      try {
        const legacy = localStorage.getItem("itera_khs_rows");
        if (legacy) {
          const parsed = JSON.parse(legacy);
          if (Array.isArray(parsed) && parsed.length > 0) {
            localStorage.removeItem("itera_khs_rows");
            initialSemestersData = { 1: parsed };
          }
        }
      } catch (e) {
        console.error("Failed to parse legacy rows", e);
      }
    }

    const defaultSemestersData = initialSemestersData || {
      1: [createEmptyRow(3), createEmptyRow(3), createEmptyRow(2), createEmptyRow(4), createEmptyRow(3)],
    };

    return [
      {
        id: "default",
        name: "Skenario Utama",
        semestersData: defaultSemestersData,
      },
    ];
  });

  const [activeScenarioId, setActiveScenarioId] = useState<string>(() => {
    return localStorage.getItem("itera_khs_active_scenario_id") || "default";
  });

  const activeScenario = scenarios.find((s) => s.id === activeScenarioId) || scenarios[0] || {
    id: "default",
    name: "Skenario Utama",
    semestersData: { 1: [createEmptyRow(3), createEmptyRow(3), createEmptyRow(2), createEmptyRow(4), createEmptyRow(3)] }
  };
  const semestersData = activeScenario.semestersData;

  const setSemestersData = (
    updater: Record<number, CourseRow[]> | ((prev: Record<number, CourseRow[]>) => Record<number, CourseRow[]>)
  ) => {
    setScenarios((prevScenarios) =>
      prevScenarios.map((s) => {
        if (s.id === activeScenario.id) {
          const newData = typeof updater === "function" ? updater(s.semestersData) : updater;
          return { ...s, semestersData: newData };
        }
        return s;
      })
    );
  };

  const handleCreateScenario = (copyGrades: boolean) => {
    const defaultName = copyGrades ? `${activeScenario.name} (Copy)` : "Skenario Baru";
    const name = window.prompt(
      copyGrades
        ? "Masukkan nama skenario duplikat:"
        : "Masukkan nama skenario baru (struktur disalin, nilai kosong):",
      defaultName
    );
    if (!name || name.trim() === "") return;

    const newId = Math.random().toString(36).substring(2, 9);
    const newSemestersData: Record<number, CourseRow[]> = {};
    
    // Copy the structure of semesters 1-14
    for (let sem = 1; sem <= 14; sem++) {
      const rows = semestersData[sem] || [];
      newSemestersData[sem] = rows.map((row) => ({
        id: Math.random().toString(36).substring(2, 9),
        name: row.name,
        sks: row.sks,
        grade: copyGrades ? row.grade : "",
      }));
    }

    const newScenario: Scenario = {
      id: newId,
      name: name.trim(),
      semestersData: newSemestersData,
    };

    setScenarios((prev) => [...prev, newScenario]);
    setActiveScenarioId(newId);
  };

  const handleRenameScenario = () => {
    const name = window.prompt("Ubah nama skenario saat ini:", activeScenario.name);
    if (!name || name.trim() === "" || name.trim() === activeScenario.name) return;

    setScenarios((prev) =>
      prev.map((s) => (s.id === activeScenario.id ? { ...s, name: name.trim() } : s))
    );
  };

  const handleDeleteScenario = () => {
    if (scenarios.length <= 1) return;
    if (window.confirm(`Apakah Anda yakin ingin menghapus skenario "${activeScenario.name}"?`)) {
      const remaining = scenarios.filter((s) => s.id !== activeScenario.id);
      setScenarios(remaining);
      setActiveScenarioId(remaining[0].id);
    }
  };

  const calculateScenarioStats = (scenario: Scenario) => {
    let cumulativeSks = 0;
    let cumulativePoints = 0;

    for (let sem = 1; sem <= 14; sem++) {
      const semRows = scenario.semestersData[sem];
      if (semRows) {
        semRows.forEach((row) => {
          const sksVal = Number(row.sks);
          const gradeVal = row.grade;

          if (sksVal > 0 && gradeVal && GRADE_WEIGHTS[gradeVal] !== undefined) {
            cumulativeSks += sksVal;
            cumulativePoints += sksVal * GRADE_WEIGHTS[gradeVal];
          }
        });
      }
    }

    const ipk = cumulativeSks > 0 ? cumulativePoints / cumulativeSks : 0;
    return { ipk, sks: cumulativeSks };
  };

  const [activeSemester, setActiveSemester] = useState<number>(1);

  const [targetIpkInput, setTargetIpkInput] = useState<string>(() => {
    const stored = localStorage.getItem("itera_khs_target_ipk");
    return stored || "3.50";
  });

  const [targetSksInput, setTargetSksInput] = useState<string>(() => {
    const stored = localStorage.getItem("itera_khs_target_sks");
    return stored || "144";
  });

  // Derived values for calculations
  const targetIpk = (() => {
    const cleanStr = targetIpkInput.replace(",", ".");
    const parsed = parseFloat(cleanStr);
    if (isNaN(parsed)) return 0;
    return Math.min(4, Math.max(0, parsed));
  })();

  const targetSks = (() => {
    const parsed = parseInt(targetSksInput);
    if (isNaN(parsed)) return 0;
    return Math.max(0, parsed);
  })();

  // File input ref
  const fileInputRef = useRef<HTMLInputElement>(null);

  // PDF import states
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [parsedCourses, setParsedCourses] = useState<ParsedCourse[]>([]);
  const [selectedPreviewSemester, setSelectedPreviewSemester] = useState<number>(1);
  const [importMode, setImportMode] = useState<"replace" | "merge">("replace");

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsParsing(true);
    setImportError(null);
    setIsImportModalOpen(true);

    try {
      const result = await parsePdfFile(file);
      if (result.courses.length === 0) {
        throw new Error("Tidak ada mata kuliah yang berhasil dideteksi dalam PDF. Pastikan format PDF sesuai.");
      }
      setParsedCourses(result.courses);

      const firstSemWithCourses = result.courses.length > 0 ? Math.min(...result.courses.map((c) => c.semester)) : 1;
      setSelectedPreviewSemester(firstSemWithCourses);
    } catch (err) {
      console.error(err);
      const errMsg = err instanceof Error ? err.message : "Gagal membaca atau memproses file PDF.";
      setImportError(errMsg);
    } finally {
      setIsParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleApplyImport = () => {
    if (parsedCourses.length === 0) return;

    const confirmMsg =
      importMode === "replace"
        ? "Tindakan ini akan menghapus semua data simulasi Anda saat ini dan menggantinya dengan data dari transkrip. Lanjutkan?"
        : "Tindakan ini akan menambahkan mata kuliah dari transkrip ke data simulasi Anda saat ini. Lanjutkan?";

    if (window.confirm(confirmMsg)) {
      setSemestersData((prev) => {
        const newData = importMode === "replace" ? {} : { ...prev };

        parsedCourses.forEach((course) => {
          const sem = course.semester;
          const cleanGrade = GRADE_WEIGHTS[course.grade] !== undefined ? course.grade : "";

          const newRow: CourseRow = {
            id: generateId(),
            name: course.name,
            sks: course.sks,
            grade: cleanGrade,
          };

          if (!newData[sem]) {
            newData[sem] = [];
          }
          newData[sem].push(newRow);
        });

        // Ensure every semester in newData has at least one row, or default empty row
        for (let sem = 1; sem <= 14; sem++) {
          if (!newData[sem] || newData[sem].length === 0) {
            if (importMode === "replace") {
              newData[sem] = [createEmptyRow(3), createEmptyRow(3), createEmptyRow(3)];
            }
          }
        }

        return newData;
      });

      const firstSemWithCourses = Math.min(...parsedCourses.map((c) => c.semester));
      setActiveSemester(firstSemWithCourses);

      setIsImportModalOpen(false);
      alert(`Berhasil mengimpor ${parsedCourses.length} mata kuliah.`);
    }
  };

  // Sync to local storage
  useEffect(() => {
    localStorage.setItem("itera_khs_scenarios", JSON.stringify(scenarios));
  }, [scenarios]);

  useEffect(() => {
    localStorage.setItem("itera_khs_active_scenario_id", activeScenarioId);
  }, [activeScenarioId]);

  useEffect(() => {
    localStorage.setItem("itera_khs_target_ipk", targetIpkInput);
  }, [targetIpkInput]);

  useEffect(() => {
    localStorage.setItem("itera_khs_target_sks", targetSksInput);
  }, [targetSksInput]);

  // Helper to retrieve rows for a specific semester
  const getRowsForSemester = (semNum: number): CourseRow[] => {
    return semestersData[semNum] || [createEmptyRow(3), createEmptyRow(3), createEmptyRow(2), createEmptyRow(4), createEmptyRow(3)];
  };

  const rows = getRowsForSemester(activeSemester);

  // Handle row input changes
  const handleInputChange = (id: string, field: keyof CourseRow, value: string | number) => {
    setSemestersData((prev) => {
      const currentRows = prev[activeSemester] || getRowsForSemester(activeSemester);
      const updatedRows = currentRows.map((row) => {
        if (row.id === id) {
          return { ...row, [field]: value };
        }
        return row;
      });
      return { ...prev, [activeSemester]: updatedRows };
    });
  };

  // Add a new empty row to the active semester
  const addRow = (defaultSks = 3) => {
    setSemestersData((prev) => {
      const currentRows = prev[activeSemester] || getRowsForSemester(activeSemester);
      return {
        ...prev,
        [activeSemester]: [...currentRows, createEmptyRow(defaultSks)],
      };
    });
  };

  // Delete a row from the active semester
  const deleteRow = (id: string) => {
    setSemestersData((prev) => {
      const currentRows = prev[activeSemester] || getRowsForSemester(activeSemester);
      const updated = currentRows.filter((row) => row.id !== id);
      return {
        ...prev,
        [activeSemester]: updated.length > 0 ? updated : [createEmptyRow(3)],
      };
    });
  };

  // Reset the active semester
  const handleResetActiveSemester = () => {
    if (window.confirm(`Apakah Anda yakin ingin menyetel ulang semua data simulasi Semester ${activeSemester}?`)) {
      setSemestersData((prev) => ({
        ...prev,
        [activeSemester]: [createEmptyRow(3), createEmptyRow(3), createEmptyRow(3)],
      }));
    }
  };

  // Calculate stats for active semester
  const calculateActiveSemesterResult = () => {
    let totalSks = 0;
    let totalPoints = 0;
    let activeCoursesCount = 0;

    rows.forEach((row) => {
      const sksVal = Number(row.sks);
      const gradeVal = row.grade;

      if (sksVal > 0 && gradeVal && GRADE_WEIGHTS[gradeVal] !== undefined) {
        totalSks += sksVal;
        totalPoints += sksVal * GRADE_WEIGHTS[gradeVal];
        activeCoursesCount++;
      }
    });

    const ips = totalSks > 0 ? totalPoints / totalSks : 0;
    return {
      ips,
      totalSks,
      activeCoursesCount,
    };
  };

  const { ips, totalSks } = calculateActiveSemesterResult();

  // Calculate cumulative stats
  const calculateCumulativeResult = () => {
    let cumulativeSks = 0;
    let cumulativePoints = 0;
    let cumulativeCoursesCount = 0;

    for (let sem = 1; sem <= 14; sem++) {
      const semRows = semestersData[sem];
      if (semRows) {
        semRows.forEach((row) => {
          const sksVal = Number(row.sks);
          const gradeVal = row.grade;

          if (sksVal > 0 && gradeVal && GRADE_WEIGHTS[gradeVal] !== undefined) {
            cumulativeSks += sksVal;
            cumulativePoints += sksVal * GRADE_WEIGHTS[gradeVal];
            cumulativeCoursesCount++;
          }
        });
      }
    }

    const ipk = cumulativeSks > 0 ? cumulativePoints / cumulativeSks : 0;
    return {
      ipk,
      cumulativeSks,
      cumulativePoints,
      cumulativeCoursesCount,
    };
  };

  const cumulativeResult = calculateCumulativeResult();

  // Calculate target estimation
  const completedSks = cumulativeResult.cumulativeSks;
  const completedPoints = cumulativeResult.cumulativePoints;
  const remainingSks = Math.max(0, targetSks - completedSks);

  let reqAvgIp = 0;
  if (remainingSks > 0) {
    const pointsNeeded = targetIpk * targetSks - completedPoints;
    reqAvgIp = pointsNeeded / remainingSks;
  }

  // Determine status and style class
  let statusClass: string;
  let statusText: string;

  if (targetSks <= completedSks) {
    if (cumulativeResult.ipk >= targetIpk) {
      statusClass = "status-reached";
      statusText = "TARGET TERCAPAI";
    } else {
      statusClass = "status-infeasible";
      statusText = "TIDAK TERCAPAI";
    }
  } else if (reqAvgIp > 4.0) {
    statusClass = "status-infeasible";
    statusText = "TIDAK MUNGKIN (> 4.00)";
  } else if (reqAvgIp <= 0) {
    statusClass = "status-reached";
    statusText = "TERPENUHI (IP 0.00)";
  } else if (reqAvgIp > 3.5) {
    statusClass = "status-infeasible";
    statusText = "SANGAT BERAT (> 3.5)";
  } else {
    statusClass = "status-achievable";
    statusText = "DAPAT DICAPAI (< 3.5)";
  }

  // Get dynamic status based on IP
  const getIpTheme = (val: number) => {
    if (val >= 3.5) {
      return {
        color: "#ffffff",
        border: "rgba(255, 255, 255, 0.3)",
      };
    } else if (val >= 3.0) {
      return {
        color: "#ffffff",
        border: "rgba(255, 255, 255, 0.2)",
      };
    } else if (val >= 2.0) {
      return {
        color: "#e2e8f0",
        border: "rgba(226, 232, 240, 0.2)",
      };
    } else if (val > 0) {
      return {
        color: "#94a3b8",
        border: "rgba(148, 163, 184, 0.15)",
      };
    } else {
      return {
        color: "#475569",
        border: "rgba(71, 85, 105, 0.12)",
      };
    }
  };

  const activeTheme = getIpTheme(ips);
  const cumulativeTheme = getIpTheme(cumulativeResult.ipk);

  return (
    <div className="container-console">
      {/* Top Banner Bar */}
      <header className="app-header-console">
        <div className="header-main">
          <h1 className="logo-title">Estimator IP &amp; IPK Semester ITERA</h1>
        </div>
      </header>

      {/* Grid Dashboard */}
      <main className="app-main-grid">
        {/* Left Column Stack */}
        <aside className="app-sidebar-left">
          {/* Panel [01]: Integrated Telemetry & Estimator */}
          <section className="console-panel panel-left-integrated" style={{ borderColor: cumulativeTheme.border }}>
            <div className="corners"></div>
            <div className="panel-tag">[01] SYSTEM TELEMETRY &amp; ESTIMATOR</div>

            {/* Dual Readout Grid */}
            <div className="integrated-telemetry-grid">
              <div className="telemetry-box">
                <span className="telemetry-lbl">IPK KUMULATIF</span>
                <div className="telemetry-val" style={{ color: cumulativeTheme.color }}>
                  {cumulativeResult.ipk.toFixed(2)}
                </div>
                <span className="telemetry-sub">{completedSks} SKS TOTAL</span>
              </div>
              <div className="telemetry-box">
                <span className="telemetry-lbl">IPS SEMESTER {activeSemester}</span>
                <div className="telemetry-val" style={{ color: activeTheme.color }}>
                  {ips.toFixed(2)}
                </div>
                <span className="telemetry-sub">{totalSks} SKS SEMESTER</span>
              </div>
            </div>

            {/* Target Estimation Engine */}
            <div className="integrated-estimator-section">
              <div className="estimator-title-integrated">ESTIMASI TARGET IPK</div>

              <div className="estimator-inputs-integrated">
                <div className="estimator-field-integrated">
                  <label htmlFor="target-ipk-input">TARGET IPK</label>
                  <input
                    id="target-ipk-input"
                    type="text"
                    inputMode="decimal"
                    className="input-estimator-terminal"
                    value={targetIpkInput}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^0-9.,]/g, "");
                      setTargetIpkInput(val);
                    }}
                    placeholder="e.g. 3.50"
                  />
                </div>
                <div className="estimator-field-integrated">
                  <label htmlFor="target-sks-input">TARGET SKS</label>
                  <input
                    id="target-sks-input"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    className="input-estimator-terminal"
                    value={targetSksInput}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^0-9]/g, "");
                      setTargetSksInput(val);
                    }}
                    placeholder="e.g. 144"
                  />
                </div>
              </div>

              <div className="estimator-results-integrated">
                <div className="estimator-row-integrated">
                  <span className="lbl">SKS Tersisa:</span>
                  <span className="val">{remainingSks} SKS</span>
                </div>
                <div className="estimator-row-integrated">
                  <span className="lbl">IP Rata-rata Dibutuhkan:</span>
                  <span className="val" style={{ color: reqAvgIp > 4.0 ? "#f43f5e" : "inherit" }}>
                    {remainingSks > 0 ? (reqAvgIp <= 0 ? "0.00" : reqAvgIp.toFixed(2)) : "N/A"}
                  </span>
                </div>

                {statusClass !== "status-achievable" && <div className={`estimator-status-box ${statusClass}`}>{statusText}</div>}
              </div>
            </div>
          </section>

          {/* Panel [01-B]: Simulation Scenarios */}
          <section className="console-panel panel-left-scenarios" style={{ marginTop: "1rem" }}>
            <div className="corners"></div>
            <div className="panel-tag">[01-B] SIMULATION SCENARIOS</div>

            <div className="scenario-selector-container">
              <div className="terminal-select-wrapper">
                <select
                  aria-label="Pilih Skenario"
                  value={activeScenarioId}
                  onChange={(e) => setActiveScenarioId(e.target.value)}
                  className="select-scenario-terminal"
                >
                  {scenarios.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <svg
                  className="chevron-arrow-terminal"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>

              <div className="scenario-action-buttons">
                <button
                  type="button"
                  className="btn-scenario-action"
                  onClick={handleRenameScenario}
                  title="Ubah nama skenario aktif"
                >
                  RENAME
                </button>
                <button
                  type="button"
                  className="btn-scenario-action"
                  onClick={() => handleCreateScenario(true)}
                  title="Duplikat skenario aktif (salin struktur &amp; nilai)"
                >
                  DUPLICATE
                </button>
                <button
                  type="button"
                  className="btn-scenario-action"
                  onClick={() => handleCreateScenario(false)}
                  title="Buat skenario baru (hanya salin struktur)"
                  style={{ gridColumn: "span 2" }}
                >
                  NEW SCENARIO (COPY STRUCT)
                </button>
                {scenarios.length > 1 && (
                  <button
                    type="button"
                    className="btn-scenario-action danger"
                    onClick={handleDeleteScenario}
                    title="Hapus skenario aktif"
                    style={{ gridColumn: "span 2" }}
                  >
                    DELETE ACTIVE
                  </button>
                )}
              </div>
            </div>

            <div className="scenario-comparison-list">
              <div className="comparison-header">PERBANDINGAN ESTIMASI IPK</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {scenarios.map((s) => {
                  const stats = calculateScenarioStats(s);
                  const isCurrent = s.id === activeScenarioId;
                  return (
                    <div
                      key={s.id}
                      className={`comparison-item ${isCurrent ? "active" : ""}`}
                      onClick={() => setActiveScenarioId(s.id)}
                    >
                      <div className="comparison-name-row">
                        <span className="comparison-name">{s.name}</span>
                        {isCurrent && <span className="active-tag">AKTIF</span>}
                      </div>
                      <div className="comparison-stats">
                        <span>
                          IPK: <strong>{stats.ipk.toFixed(2)}</strong>
                        </span>
                        <span>{stats.sks} SKS</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </aside>

        {/* Right Column: Simulator Inputs */}
        <section className="console-panel panel-right">
          <div className="corners"></div>
          <div className="panel-header-row">
            <div className="panel-tag">[02] SIMULATOR DATA INPUT</div>
            <div className="input-controls-group">
              {/* Semester Selector Dropdown */}
              <div className="terminal-select-wrapper header-semester-select-wrapper">
                <select
                  id="semester-select"
                  className="select-semester-terminal header-select-semester"
                  value={activeSemester}
                  onChange={(e) => setActiveSemester(parseInt(e.target.value) || 1)}
                  aria-label="Pilih Semester"
                >
                  {Array.from({ length: 14 }, (_, i) => i + 1).map((semNum) => (
                    <option key={semNum} value={semNum}>
                      SEM {semNum}
                    </option>
                  ))}
                </select>
                <svg
                  className="chevron-arrow-terminal"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>

              <button className="btn-reset" onClick={handleResetActiveSemester} title={`Reset data untuk Semester ${activeSemester}`}>
                RESET
              </button>
              <button className="btn-import-pdf" onClick={() => fileInputRef.current?.click()} title="Import data dari transkrip PDF">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ width: "12px", height: "12px" }}
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="17 8 12 3 7 8"></polyline>
                  <line x1="12" y1="3" x2="12" y2="15"></line>
                </svg>
                IMPORT PDF
              </button>
              <input type="file" ref={fileInputRef} style={{ display: "none" }} accept=".pdf" onChange={handleFileChange} />
            </div>
          </div>

          <div className="terminal-table-scroll-wrapper">
            <div className="terminal-table-headers">
              <span className="hdr-id">INDEX</span>
              <span className="hdr-name">MATA KULIAH (OPSIONAL)</span>
              <span className="hdr-sks">SKS</span>
              <span className="hdr-grade">NILAI</span>
              <span className="hdr-action"></span>
            </div>

            <div className="course-list-console">
              {rows.map((row, index) => (
                <div key={row.id} className="course-console-row">
                  <div className="field-index-tag">[R-{(index + 1).toString().padStart(2, "0")}]</div>

                  <div className="field-name">
                    <input
                      type="text"
                      className="input-text-terminal"
                      placeholder="MATKUL ID"
                      value={row.name}
                      onChange={(e) => handleInputChange(row.id, "name", e.target.value)}
                      aria-label={`Nama mata kuliah baris ke-${index + 1}`}
                    />
                  </div>

                  <div className="field-sks">
                    <input
                      type="number"
                      className="input-sks-terminal"
                      placeholder="0"
                      min="0"
                      max="10"
                      value={row.sks || ""}
                      onChange={(e) => {
                        const val = e.target.value === "" ? 0 : Math.max(0, parseInt(e.target.value) || 0);
                        handleInputChange(row.id, "sks", val);
                      }}
                      aria-label={`Jumlah SKS baris ke-${index + 1}`}
                    />
                  </div>

                  <div className="field-grade">
                    <div className="terminal-select-wrapper">
                      <select
                        className={`select-grade-terminal ${row.grade ? "filled" : ""}`}
                        value={row.grade}
                        onChange={(e) => handleInputChange(row.id, "grade", e.target.value)}
                        aria-label={`Nilai huruf baris ke-${index + 1}`}
                      >
                        <option value="">NILAI</option>
                        <option value="A">A (4.0)</option>
                        <option value="AB">AB (3.5)</option>
                        <option value="B">B (3.0)</option>
                        <option value="BC">BC (2.5)</option>
                        <option value="C">C (2.0)</option>
                        <option value="D">D (1.0)</option>
                        <option value="E">E (0.0)</option>
                      </select>
                      <svg
                        className="chevron-arrow-terminal"
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="6 9 12 15 18 9"></polyline>
                      </svg>
                    </div>
                  </div>

                  <div className="field-action">
                    <button className="btn-delete-terminal" onClick={() => deleteRow(row.id)} title="Delete row data" aria-label={`Hapus mata kuliah baris ke-${index + 1}`}>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="terminal-actions-footer">
            <button className="btn-add-terminal" onClick={() => addRow(3)}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              ADD TERMINAL ROW
            </button>
          </div>
        </section>
      </main>

      <footer className="app-footer-console">
        <p className="copyright-console">// TERMINAL CALCULATOR INTERFACE // ITERA CAMPUS CONTROL SYSTEM CO. // SECURE TRANSMISSION</p>
      </footer>

      {/* Import PDF Preview Modal */}
      {isImportModalOpen && (
        <div className="import-modal-overlay">
          <div className="import-modal-container console-panel">
            <div className="corners"></div>
            <div className="panel-tag">[03] PREVIEW IMPORT TRANSKRIP</div>

            <div className="modal-header">
              <h2 className="modal-title">Konfirmasi &amp; Pengaturan Semester</h2>
              <button className="btn-close-modal" onClick={() => setIsImportModalOpen(false)} aria-label="Tutup modal">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>

            {isParsing ? (
              <div className="parsing-loading-overlay">
                <div className="terminal-spinner"></div>
                <p>Sedang mengekstrak dan memproses data transkrip PDF...</p>
              </div>
            ) : importError ? (
              <div className="parsing-loading-overlay" style={{ color: "#f43f5e" }}>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ marginBottom: "0.5rem" }}
                >
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="8" x2="12" y2="12"></line>
                  <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
                <p style={{ fontWeight: "bold" }}>Terjadi Kesalahan</p>
                <p style={{ textAlign: "center", maxWidth: "400px", fontSize: "0.8rem" }}>{importError}</p>
                <button className="btn-reset" style={{ marginTop: "1rem", borderColor: "#f43f5e", color: "#f43f5e" }} onClick={() => setIsImportModalOpen(false)}>
                  TUTUP
                </button>
              </div>
            ) : (
              <>
                {/* Main Workspace: Tabs and Courses list */}
                <div className="modal-workspace">
                  {/* Semester Tabs list */}
                  <div className="semester-sidebar-list">
                    {Array.from({ length: 14 }, (_, i) => i + 1).map((semNum) => {
                      const coursesInSem = parsedCourses.filter((c) => c.semester === semNum);
                      const totalSksInSem = coursesInSem.reduce((acc, c) => acc + c.sks, 0);
                      const hasCourses = coursesInSem.length > 0;

                      return (
                        <button
                          key={semNum}
                          className={`semester-tab-btn ${selectedPreviewSemester === semNum ? "active" : ""} ${hasCourses ? "has-data" : ""}`}
                          style={{ opacity: hasCourses ? 1 : 0.4 }}
                          onClick={() => setSelectedPreviewSemester(semNum)}
                        >
                          <span>SEM {semNum}</span>
                          {hasCourses && (
                            <span className="semester-tab-badge">
                              {coursesInSem.length} Mk ({totalSksInSem} S)
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Courses in selected Semester */}
                  <div className="courses-preview-panel">
                    {(() => {
                      const coursesToShow = parsedCourses.filter((c) => c.semester === selectedPreviewSemester);

                      if (coursesToShow.length === 0) {
                        return (
                          <div className="empty-semester-placeholder">
                            <p>Tidak ada mata kuliah di Semester {selectedPreviewSemester}</p>
                            <p style={{ fontSize: "0.7rem", opacity: 0.6 }}>Gunakan menu dropdown pada mata kuliah di semester lain untuk memindahkannya ke sini.</p>
                          </div>
                        );
                      }

                      // Calculate IPS for preview
                      let totalPoints = 0;
                      let totalSks = 0;
                      coursesToShow.forEach((c) => {
                        const weight = GRADE_WEIGHTS[c.grade];
                        if (weight !== undefined) {
                          totalPoints += c.sks * weight;
                          totalSks += c.sks;
                        }
                      });
                      const previewIps = totalSks > 0 ? totalPoints / totalSks : 0;

                      return (
                        <>
                          <div className="semester-preview-summary">
                            <span className="summary-title">MATA KULIAH SEMESTER {selectedPreviewSemester}</span>
                            <div className="summary-stats">
                              <span>
                                TOTAL SKS: <strong>{totalSks}</strong>
                              </span>
                              <span>
                                ESTIMASI IPS: <strong>{previewIps.toFixed(2)}</strong>
                              </span>
                            </div>
                          </div>

                          <div className="preview-table-scroll-wrapper">
                            <div className="preview-table-header">
                              <span>NAMA MATA KULIAH</span>
                              <span>SKS</span>
                              <span>NILAI</span>
                              <span>PINDAH SEMESTER</span>
                            </div>

                            {coursesToShow.map((course) => (
                              <div key={course.id} className="preview-course-row">
                                <span className="preview-course-name" title={course.name}>
                                  {course.name}
                                </span>
                                <span className="preview-course-sks">{course.sks} SKS</span>
                                <span className={`preview-course-grade grade-${course.grade}`}>{course.grade || "-"}</span>

                                <select
                                  className="select-move-semester"
                                  value={course.semester}
                                  onChange={(e) => {
                                    const newSem = parseInt(e.target.value);
                                    setParsedCourses((prev) => prev.map((c) => (c.id === course.id ? { ...c, semester: newSem } : c)));
                                  }}
                                >
                                  {Array.from({ length: 14 }, (_, i) => i + 1).map((semNum) => (
                                    <option key={semNum} value={semNum}>
                                      Pindahkan ke Sem {semNum}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ))}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>

                {/* Footer Controls */}
                <div className="modal-footer">
                  <div className="segmented-control-terminal">
                    <button type="button" className={`segment-btn ${importMode === "replace" ? "active" : ""}`} onClick={() => setImportMode("replace")}>
                      OVERWRITE DATA
                    </button>
                    <button type="button" className={`segment-btn ${importMode === "merge" ? "active" : ""}`} onClick={() => setImportMode("merge")}>
                      MERGE DATA
                    </button>
                  </div>

                  <div className="modal-actions">
                    <button className="btn-modal-cancel btn-reset" onClick={() => setIsImportModalOpen(false)}>
                      BATAL
                    </button>
                    <button className="btn-modal-apply btn-add-terminal" style={{ width: "auto" }} onClick={handleApplyImport}>
                      TERAPKAN SIMULASI ({parsedCourses.length} MK)
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
