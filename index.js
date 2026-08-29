// DOM Elements
const initBtn = document.getElementById("init-btn");
const statusDiv = document.getElementById("status");
const slotsInput = document.getElementById("slots-input");
const slotsList = document.getElementById("slots-list");
const cellsBoard = document.getElementById("cells-board");
const candidatesList = document.getElementById("candidates-list");
const uploadBtn = document.getElementById("upload-btn");
const dictFileInput = document.getElementById("dict-file-input");
const uploadedDictName = document.getElementById("uploaded-dict-name");
const minScoreInput = document.getElementById("min-score-input");
const openSettingsBtn = document.getElementById("open-settings-btn");
const cancelSettingsBtn = document.getElementById("cancel-settings-btn");
const closeModalX = document.getElementById("close-modal-x");
const settingsModal = document.getElementById("settings-modal");
const activeDictLabel = document.getElementById("active-dict-label");
const activeScoreLabel = document.getElementById("active-score-label");
const undoBtn = document.getElementById("undo-btn");
const copyBtn = document.getElementById("copy-btn");
const activePuzzleLabel = document.getElementById("active-puzzle-label");
const puzzleNameInput = document.getElementById("puzzle-name-input");
const loadPuzzleSelect = document.getElementById("load-puzzle-select");
const puzzleNameGroup = document.getElementById("puzzle-name-group");
const slotsGroup = document.getElementById("slots-group");
const tabLoadBtn = document.getElementById("tab-load-btn");
const tabNewBtn = document.getElementById("tab-new-btn");
const tabContentLoad = document.getElementById("tab-content-load");
const tabContentNew = document.getElementById("tab-content-new");

let cellNames = [];
let slotConfigs = [];
let activeSlotId = null;
let remainingOptions = [];
let dictContents = "";
let activeCandidates = [];
let lastFillTime = 0;
let initialCellValues = {};
let undoHistory = [];
let activePuzzleName = "";
let activeTab = "load";

// Initialize background solver Web Worker
const worker = new Worker("solver-worker.js", { type: "module" });

// Handle messages from Solver Worker
worker.onmessage = (e) => {
    const { type, payload } = e.data;

    switch (type) {
        case "INIT_SUCCESS":
            cellNames = payload.cellNames;
            slotConfigs = payload.slotConfigs;
            initialCellValues = payload.initialCellValues;

            // Reset state from previous runs
            activeSlotId = null;
            remainingOptions = [];
            activeCandidates = [];
            undoHistory = [];
            updateUndoButton();
            renderCandidates();

            renderBoard();
            renderSlotsList();
            propagateConstraints();
            statusDiv.textContent = "Status: Solver Initialized.";

            // Close settings modal and update labels
            settingsModal.classList.remove("open");
            activeDictLabel.textContent = uploadedDictName.textContent;
            activeScoreLabel.textContent = minScoreInput.value;

            if (window.innerWidth <= 900) {
                switchMobileTab("center-panel");
            }
            break;

        case "AC3_SUCCESS":
            remainingOptions = payload.remainingOptions;

            // Update slot badges with option counts
            slotConfigs.forEach(slot => {
                const count = remainingOptions[slot.id].length;
                const badge = document.getElementById(`slot-len-badge-${slot.id}`);
                if (badge) {
                    badge.textContent = `${count} options`;
                    if (count === 0) {
                        badge.style.backgroundColor = "#ef4444"; // red alert
                        badge.style.color = "white";
                    } else if (count === 1) {
                        badge.style.backgroundColor = "#10b981"; // green fixed
                        badge.style.color = "white";
                    } else {
                        badge.style.backgroundColor = "";
                        badge.style.color = "";
                    }
                }
            });

            // Update active candidates list
            if (activeSlotId !== null) {
                updateActiveCandidates(remainingOptions[activeSlotId] || []);
            }
            break;

        case "VALIDATION_RESULT":
            const { word, isFillable, slotId } = payload;
            if (slotId !== activeSlotId) return;
            handleValidationResult(word, isFillable);
            break;

        case "ERROR":
            statusDiv.textContent = `Status: Solver error: ${payload}`;
            console.error(payload);
            break;
    }
};

// Initialize Wasm module by downloading default word list or loading from IndexedDB/localStorage
async function run() {
    try {
        cleanOldSaves();
        populateLoadDropdown();

        // Find the last active puzzle
        const lastActive = localStorage.getItem("ingrid_last_active_puzzle");
        const puzzles = getSavedPuzzles();
        let activePuzzle = null;

        if (lastActive && puzzles[lastActive]) {
            activePuzzle = puzzles[lastActive];
            activePuzzleName = lastActive;
        } else {
            // Default to the newest puzzle if lastActive is missing or invalid
            const sortedNames = Object.keys(puzzles).sort((a, b) => puzzles[b].timestamp - puzzles[a].timestamp);
            if (sortedNames.length > 0) {
                activePuzzleName = sortedNames[0];
                activePuzzle = puzzles[activePuzzleName];
            }
        }

        if (activePuzzle) {
            puzzleNameInput.value = activePuzzleName;
            activePuzzleLabel.textContent = activePuzzleName;
            slotsInput.value = activePuzzle.slotsDef;
            minScoreInput.value = activePuzzle.minScore;
            activeScoreLabel.textContent = activePuzzle.minScore;
            uploadedDictName.textContent = activePuzzle.dictName || "spreadthewordlist.dict";
            activeDictLabel.textContent = activePuzzle.dictName || "spreadthewordlist.dict";
        } else {
            // No saved puzzles, initialize a default name
            const defaultName = generateDefaultPuzzleName();
            puzzleNameInput.value = defaultName;
            activePuzzleLabel.textContent = defaultName;
        }

        const dictToLoad = activePuzzle ? (activePuzzle.dictName || "spreadthewordlist.dict") : "spreadthewordlist.dict";

        if (dictToLoad && dictToLoad !== "spreadthewordlist.dict") {
            // Fallback to default but alert user
            statusDiv.textContent = `Status: Custom list "${dictToLoad}" not persisted. Downloading default...`;
            const response = await fetch("resources/spreadthewordlist.dict");
            if (!response.ok) {
                throw new Error(`Failed to load dictionary: ${response.statusText}`);
            }
            dictContents = await response.text();
            uploadedDictName.textContent = "spreadthewordlist.dict";
            activeDictLabel.textContent = "spreadthewordlist.dict";
        } else {
            statusDiv.textContent = "Status: Downloading default dictionary...";
            const response = await fetch("resources/spreadthewordlist.dict");
            if (!response.ok) {
                throw new Error(`Failed to load dictionary: ${response.statusText}`);
            }
            dictContents = await response.text();
        }

        statusDiv.textContent = "Status: Ready! Click 'Initialize Solver'.";
        initBtn.disabled = false;

        // Auto-initialize the default grid
        initializeSolver();
    } catch (e) {
        statusDiv.textContent = `Status: Error initializing: ${e.message}`;
        console.error(e);
    }
}

// Initialize Solver instance in worker thread
function initializeSolver() {
    if (!dictContents) {
        statusDiv.textContent = "Status: Dictionary not loaded yet.";
        return;
    }

    let name = "";
    let slotsDef = "";
    const minScore = parseInt(minScoreInput.value) || 0;

    if (activeTab === "load") {
        name = loadPuzzleSelect.value;
        if (!name) {
            statusDiv.textContent = "Status: Please select a puzzle to load, or switch to the 'Create New' tab.";
            return;
        }
        const puzzles = getSavedPuzzles();
        const puzzle = puzzles[name];
        if (!puzzle) {
            statusDiv.textContent = "Status: Selected puzzle not found in saves.";
            return;
        }
        slotsDef = puzzle.slotsDef;
    } else {
        name = puzzleNameInput.value.trim();
        if (!name) {
            name = generateDefaultPuzzleName();
            puzzleNameInput.value = name;
        }
        slotsDef = slotsInput.value;
    }

    activePuzzleName = name;
    activePuzzleLabel.textContent = name;

    statusDiv.textContent = "Status: Initializing solver in background...";

    const puzzles = getSavedPuzzles();
    const existing = puzzles[name];
    let fills = {};
    if (existing && existing.slotsDef === slotsDef) {
        fills = existing.fills || {};
    }

    // Save initial puzzle state
    savePuzzleState(name, {
        slotsDef,
        minScore,
        dictName: uploadedDictName.textContent,
        fills
    });

    worker.postMessage({
        type: "INIT",
        payload: { slotsDef, minScore, dictContents }
    });
}


// Render cells on the board by word slots
function renderBoard() {
    cellsBoard.innerHTML = "";

    const puzzles = getSavedPuzzles();
    const puzzle = puzzles[activePuzzleName] || {};
    const savedFills = puzzle.fills || {};

    slotConfigs.forEach(slot => {
        const row = document.createElement("div");
        row.className = "board-row";
        row.id = `board-row-${slot.id}`;

        const label = document.createElement("span");
        label.className = "board-row-label";
        label.textContent = `Slot ${slot.id + 1}`;

        const inputsContainer = document.createElement("div");
        inputsContainer.className = "board-row-inputs";

        slot.cells.forEach((cellName, charIdx) => {
            const square = document.createElement("div");
            square.className = "cell-square";
            square.dataset.cell = cellName;

            const cellLabel = document.createElement("span");
            cellLabel.className = "cell-square-name";
            cellLabel.textContent = cellName;

            const input = document.createElement("input");
            input.className = "cell-square-input";
            input.type = "text";
            input.maxLength = 1;
            input.dataset.cell = cellName;
            input.dataset.slotId = slot.id;
            input.dataset.charIdx = charIdx;

            if (savedFills[cellName] !== undefined) {
                input.value = savedFills[cellName].toLowerCase();
            } else if (initialCellValues[cellName]) {
                input.value = initialCellValues[cellName].toLowerCase();
            }

            // Sync values across all cells sharing this name
            input.addEventListener("input", (e) => {
                const val = e.target.value.toLowerCase().replace(/[^a-z]/g, '');

                // Find all inputs sharing the same cell name and sync them
                document.querySelectorAll(`input[data-cell="${cellName}"]`).forEach(inp => {
                    inp.value = val;
                });

                propagateConstraints();

                // Auto-advance to the next cell in the slot if we typed a character
                if (val.length > 0 && charIdx < slot.cells.length - 1) {
                    const nextInput = document.querySelector(
                        `input[data-slot-id="${slot.id}"][data-char-idx="${charIdx + 1}"]`
                    );
                    if (nextInput) {
                        nextInput.focus();
                    }
                }
            });

            // Backspace navigation and save state
            input.addEventListener("keydown", (e) => {
                if (e.key === "Backspace" || /^[a-zA-Z]$/.test(e.key)) {
                    saveState();
                }
                if (e.key === "Backspace") {
                    e.preventDefault();

                    // Clear cell value
                    input.value = "";
                    document.querySelectorAll(`input[data-cell="${cellName}"]`).forEach(inp => {
                        inp.value = "";
                    });

                    propagateConstraints();

                    // Navigate to previous cell in the same slot
                    if (charIdx > 0) {
                        const prevInput = document.querySelector(
                            `input[data-slot-id="${slot.id}"][data-char-idx="${charIdx - 1}"]`
                        );
                        if (prevInput) {
                            prevInput.focus();
                        }
                    }
                }
            });

            // Highlight crossings on focus
            input.addEventListener("focus", () => {
                selectSlot(slot.id); // Clicking/focusing an input selects its slot!

                document.querySelectorAll(".cell-square").forEach(sq => {
                    sq.classList.remove("crossing-highlight");
                });
                document.querySelectorAll(`.cell-square[data-cell="${cellName}"]`).forEach(sq => {
                    sq.classList.add("crossing-highlight");
                });
            });

            input.addEventListener("blur", () => {
                document.querySelectorAll(".cell-square").forEach(sq => {
                    sq.classList.remove("crossing-highlight");
                });
            });

            square.appendChild(cellLabel);
            square.appendChild(input);
            inputsContainer.appendChild(square);
        });

        row.appendChild(label);
        row.appendChild(inputsContainer);

        // Clicking the row selects the slot
        row.addEventListener("click", (e) => {
            if (e.target.tagName !== "INPUT") {
                selectSlot(slot.id);
            }
        });

        cellsBoard.appendChild(row);
    });
}

// Render word slots list in left panel
function renderSlotsList() {
    slotsList.innerHTML = "";

    slotConfigs.forEach(slot => {
        const item = document.createElement("div");
        item.className = "slot-item";
        item.dataset.id = slot.id;
        item.id = `slot-item-${slot.id}`;

        const nameSpan = document.createElement("span");
        nameSpan.className = "slot-name";
        nameSpan.textContent = `Slot ${slot.id + 1}: ${slot.cells.join(" ")}`;

        const lengthSpan = document.createElement("span");
        lengthSpan.className = "slot-length";
        lengthSpan.id = `slot-len-badge-${slot.id}`;
        lengthSpan.textContent = `${slot.length} letters`;

        item.appendChild(nameSpan);
        item.appendChild(lengthSpan);

        item.addEventListener("click", () => {
            selectSlot(slot.id);
            if (window.innerWidth <= 900) {
                switchMobileTab("right-panel");
            }
        });

        slotsList.appendChild(item);
    });
}

// Select a word slot
function selectSlot(slotId) {
    activeSlotId = slotId;

    // Update active class in slots list
    document.querySelectorAll(".slot-item").forEach(item => {
        item.classList.remove("active");
    });
    const slotItem = document.getElementById(`slot-item-${slotId}`);
    if (slotItem) slotItem.classList.add("active");

    // Update active class in board rows
    document.querySelectorAll(".board-row").forEach(row => {
        row.classList.remove("active");
    });
    const boardRow = document.getElementById(`board-row-${slotId}`);
    if (boardRow) boardRow.classList.add("active");

    // Update active candidates list (triggers background worker validation)
    updateActiveCandidates(remainingOptions[slotId] || []);
}

// Update undo button disabled status
function updateUndoButton() {
    if (undoHistory.length > 0) {
        undoBtn.disabled = false;
    } else {
        undoBtn.disabled = true;
    }
}

// Save current board fill state to undo history
function saveState() {
    const currentState = getBoardFill();
    // Only push if it is different from the last state in history (to prevent duplicates)
    if (undoHistory.length === 0 || JSON.stringify(undoHistory[undoHistory.length - 1]) !== JSON.stringify(currentState)) {
        undoHistory.push(currentState);
        updateUndoButton();
    }
}

// Restore the board to the previous state
function undo() {
    if (undoHistory.length === 0) return;
    const previousState = undoHistory.pop();

    // Restore the cell values on the board
    cellNames.forEach(name => {
        const val = previousState[name] || "";
        document.querySelectorAll(`input[data-cell="${name}"]`).forEach(inp => {
            inp.value = val;
        });
    });

    updateUndoButton();
    propagateConstraints();
}

// Read current board fill state
function getBoardFill() {
    const fill = {};
    cellNames.forEach(name => {
        const inp = document.querySelector(`input[data-cell="${name}"]`);
        const val = inp ? inp.value : "";
        if (val && val.length > 0) {
            fill[name] = val;
        }
    });
    return fill;
}

// Update copy button disabled status based on whether all cells/slots are filled
function updateCopyButton() {
    const allFilled = slotConfigs.length > 0 && slotConfigs.every(slot => {
        return slot.cells.every(cellName => {
            const inp = document.querySelector(`input[data-slot-id="${slot.id}"][data-cell="${cellName}"]`);
            return inp && inp.value.trim() !== "";
        });
    });
    copyBtn.disabled = !allFilled;
}

// Copy filled slot entries to clipboard joined with newlines
function copyFill() {
    const words = slotConfigs.map(slot => {
        return slot.cells.map(cellName => {
            const inp = document.querySelector(`input[data-slot-id="${slot.id}"][data-cell="${cellName}"]`);
            return inp ? inp.value.toLowerCase() : "";
        }).join("");
    });

    const textToCopy = words.join("\n");

    navigator.clipboard.writeText(textToCopy).then(() => {
        const oldText = copyBtn.textContent;
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
            copyBtn.textContent = oldText;
        }, 1500);
    }).catch(err => {
        console.error("Failed to copy text: ", err);
        statusDiv.textContent = "Status: Failed to copy fill to clipboard.";
    });
}

// Run AC-3 constraint propagation in worker thread
function propagateConstraints() {
    const fill = getBoardFill();
    worker.postMessage({
        type: "RUN_AC3",
        payload: { fillJson: JSON.stringify(fill) }
    });
    updateCopyButton();
    saveCurrentPuzzleProgress();
}

// Render candidates based on activeCandidates array
function renderCandidates() {
    candidatesList.innerHTML = "";

    if (activeSlotId === null) {
        candidatesList.innerHTML = `<div class="no-candidates">Select a word slot to see options.</div>`;
        return;
    }

    if (activeCandidates.length === 0) {
        candidatesList.innerHTML = `<div class="no-candidates" style="color: #ef4444;">No viable candidate words match the current board constraints!</div>`;
        return;
    }

    activeCandidates.forEach(cand => {
        const item = document.createElement("div");
        item.className = `candidate-item ${cand.state}`;
        item.textContent = cand.word;

        item.addEventListener("mousedown", () => {
            fillSlot(activeSlotId, cand.word);
        });

        cand.element = item;
        candidatesList.appendChild(item);
    });
}

// Cancel current validation task and rebuild candidate list
function updateActiveCandidates(options) {
    worker.postMessage({ type: "STOP_VALIDATION" });

    activeCandidates = options.map((word, idx) => ({ word, state: "pending", element: null, originalIdx: idx }));
    renderCandidates();

    if (activeSlotId !== null && activeCandidates.length > 0) {
        worker.postMessage({
            type: "START_VALIDATION",
            payload: {
                slotId: activeSlotId,
                options: options,
                fillJson: JSON.stringify(getBoardFill())
            }
        });
    }
}

// Handle validation results returned by the worker
function handleValidationResult(word, isFillable) {
    const candIdx = activeCandidates.findIndex(cand => cand.word === word);
    if (candIdx === -1) return;

    const candidate = activeCandidates[candIdx];
    if (isFillable) {
        candidate.state = "valid";
        if (candidate.element) {
            candidate.element.className = "candidate-item valid";
        }

        // Sort valid ones first, maintaining their original score order (originalIdx)
        activeCandidates.sort((a, b) => {
            if (a.state === "valid" && b.state !== "valid") return -1;
            if (a.state !== "valid" && b.state === "valid") return 1;
            return a.originalIdx - b.originalIdx;
        });

        // Re-append elements in the new sorted order to rearrange the DOM in-place
        activeCandidates.forEach(cand => {
            if (cand.element) {
                candidatesList.appendChild(cand.element);
            }
        });
    } else {
        // Remove element from DOM
        if (candidate.element) {
            candidate.element.remove();
        }
        // Remove candidate from array
        activeCandidates.splice(candIdx, 1);

        if (activeCandidates.length === 0) {
            candidatesList.innerHTML = `<div class="no-candidates" style="color: #ef4444;">No viable candidate words match the current board constraints!</div>`;
        }
    }
}

// Check if a slot has any empty cells
function isSlotIncomplete(slotId) {
    const slot = slotConfigs[slotId];
    return slot.cells.some(cellName => {
        const inp = document.querySelector(`input[data-slot-id="${slotId}"][data-cell="${cellName}"]`);
        return !inp || inp.value === "";
    });
}

// Find and select the incomplete slot with the fewest remaining options
function selectNextConstrainedSlot() {
    let bestSlotId = null;
    let minOptions = Infinity;

    slotConfigs.forEach(slot => {
        if (isSlotIncomplete(slot.id)) {
            const count = remainingOptions[slot.id].length;
            if (count > 0 && count < minOptions) {
                minOptions = count;
                bestSlotId = slot.id;
            }
        }
    });

    if (bestSlotId !== null) {
        selectSlot(bestSlotId);

        // Focus the first empty input in the newly selected slot row
        const slot = slotConfigs[bestSlotId];
        for (let cellName of slot.cells) {
            const inp = document.querySelector(`input[data-slot-id="${bestSlotId}"][data-cell="${cellName}"]`);
            if (inp && inp.value === "") {
                inp.focus();
                break;
            }
        }
    }
}

// Autofill a slot with a word selection
function fillSlot(slotId, word) {
    const now = Date.now();
    if (now - lastFillTime < 300) {
        return; // Ignore double clicks/taps within 300ms
    }
    lastFillTime = now;

    saveState();

    const slot = slotConfigs[slotId];
    for (let i = 0; i < slot.cells.length; i++) {
        const cellName = slot.cells[i];
        const letter = word[i];
        document.querySelectorAll(`input[data-cell="${cellName}"]`).forEach(inp => {
            inp.value = letter;
        });
    }

    // Propagate constraint changes
    propagateConstraints();

    // Jump to the most constrained incomplete slot
    selectNextConstrainedSlot();
}

// Event Listeners
initBtn.addEventListener("click", initializeSolver);
undoBtn.addEventListener("click", undo);
copyBtn.addEventListener("click", copyFill);

uploadBtn.addEventListener("click", () => {
    dictFileInput.click();
});

dictFileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    uploadedDictName.textContent = file.name;
    statusDiv.textContent = `Status: Reading ${file.name}...`;

    const reader = new FileReader();
    reader.onload = (event) => {
        dictContents = event.target.result;
        initializeSolver();
    };
    reader.onerror = (err) => {
        statusDiv.textContent = `Status: Error reading file: ${err}`;
    };
    reader.readAsText(file);
});

minScoreInput.addEventListener("change", (e) => {
    const val = parseInt(e.target.value) || 0;
    worker.postMessage({ type: "UPDATE_MIN_SCORE", payload: { minScore: val } });
    statusDiv.textContent = `Status: Min score updated to ${val}. Re-running constraints...`;
    propagateConstraints();
});

// Modal Event Listeners
openSettingsBtn.addEventListener("click", () => {
    settingsModal.classList.add("open");
    if (activePuzzleName && getSavedPuzzles()[activePuzzleName]) {
        activeTab = "load";
        tabLoadBtn.classList.add("active");
        tabNewBtn.classList.remove("active");
        tabContentLoad.classList.add("active");
        tabContentNew.classList.remove("active");
        loadPuzzleSelect.value = activePuzzleName;
    } else {
        activeTab = "new";
        tabNewBtn.classList.add("active");
        tabLoadBtn.classList.remove("active");
        tabContentNew.classList.add("active");
        tabContentLoad.classList.remove("active");
        if (!puzzleNameInput.value) {
            puzzleNameInput.value = generateDefaultPuzzleName();
        }
    }
});

const closeModal = () => {
    settingsModal.classList.remove("open");
    // Revert inputs in modal to active values if canceled
    minScoreInput.value = activeScoreLabel.textContent;
};

cancelSettingsBtn.addEventListener("click", closeModal);
closeModalX.addEventListener("click", closeModal);

loadPuzzleSelect.addEventListener("change", (e) => {
    const name = e.target.value;
    if (!name) return;
    
    const puzzles = getSavedPuzzles();
    const puzzle = puzzles[name];
    if (puzzle) {
        puzzleNameInput.value = name;
        slotsInput.value = puzzle.slotsDef;
        minScoreInput.value = puzzle.minScore;
        
        if (puzzle.dictName) {
            uploadedDictName.textContent = puzzle.dictName;
        }
    }
});

tabLoadBtn.addEventListener("click", () => {
    activeTab = "load";
    tabLoadBtn.classList.add("active");
    tabNewBtn.classList.remove("active");
    tabContentLoad.classList.add("active");
    tabContentNew.classList.remove("active");
});

tabNewBtn.addEventListener("click", () => {
    activeTab = "new";
    tabNewBtn.classList.add("active");
    tabLoadBtn.classList.remove("active");
    tabContentNew.classList.add("active");
    tabContentLoad.classList.remove("active");
});

// Helper to generate a puzzle name with timestamp
function generateDefaultPuzzleName() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = now.getFullYear();
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const hh = pad(now.getHours());
    const min = pad(now.getMinutes());
    const ss = pad(now.getSeconds());
    return `Untitled puzzle ${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

// LocalStorage helpers for saved states
const SAVES_KEY = "ingrid_saved_puzzles";
const LAST_ACTIVE_KEY = "ingrid_last_active_puzzle";

function getSavedPuzzles() {
    try {
        return JSON.parse(localStorage.getItem(SAVES_KEY) || "{}");
    } catch (e) {
        console.error(e);
        return {};
    }
}

function savePuzzleState(puzzleName, state) {
    const puzzles = getSavedPuzzles();
    puzzles[puzzleName] = {
        ...state,
        timestamp: Date.now()
    };
    localStorage.setItem(SAVES_KEY, JSON.stringify(puzzles));
    localStorage.setItem(LAST_ACTIVE_KEY, puzzleName);
    populateLoadDropdown();
}

function cleanOldSaves() {
    const puzzles = getSavedPuzzles();
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    let changed = false;
    for (const name in puzzles) {
        if (now - puzzles[name].timestamp > thirtyDaysMs) {
            delete puzzles[name];
            changed = true;
        }
    }
    if (changed) {
        localStorage.setItem(SAVES_KEY, JSON.stringify(puzzles));
    }
}

function populateLoadDropdown() {
    loadPuzzleSelect.innerHTML = '<option value="">-- Select a puzzle --</option>';
    const puzzles = getSavedPuzzles();
    const sortedNames = Object.keys(puzzles).sort((a, b) => puzzles[b].timestamp - puzzles[a].timestamp);
    
    sortedNames.forEach(name => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        loadPuzzleSelect.appendChild(opt);
    });
}

function saveCurrentPuzzleProgress() {
    if (!activePuzzleName) return;
    
    savePuzzleState(activePuzzleName, {
        slotsDef: slotsInput.value,
        minScore: minScoreInput.value,
        dictName: uploadedDictName.textContent,
        fills: getBoardFill()
    });
}

// Mobile navigation tabs functionality
function switchMobileTab(tabId) {
    const mainContainer = document.querySelector(".main-container");
    const tabButtons = document.querySelectorAll(".mobile-tab-btn");
    
    tabButtons.forEach(btn => {
        if (btn.getAttribute("data-tab") === tabId) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });

    if (mainContainer) {
        mainContainer.classList.remove("show-left", "show-center", "show-right");
        if (tabId === "left-panel") {
            mainContainer.classList.add("show-left");
        } else if (tabId === "center-panel") {
            mainContainer.classList.add("show-center");
        } else if (tabId === "right-panel") {
            mainContainer.classList.add("show-right");
        }
    }
}

// Attach listeners to mobile tab buttons
document.querySelectorAll(".mobile-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const tabId = btn.getAttribute("data-tab");
        switchMobileTab(tabId);
    });
});

// Start
run();
