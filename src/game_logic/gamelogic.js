import UNITS_BY_NAME from "../constants/units_by_name"
import TRAINED_BY from "../constants/trained_by"
import UPGRADES_BY_NAME from "../constants/upgrade_by_name"
import RESEARCHED_BY from "../constants/researched_by"
import {incomeMinerals, incomeVespene} from "./income"

import {cloneDeep} from 'lodash'

import Unit from "./unit"
import Event from "./event"
import Task from "./task"
import executeAction from "./execute_action"

/** Logic of this file:
Each frame
    Calculate and add income
    Update the state of each unit:
        Update energy available
        Update progress (if they are doing something)
    Check if the next build order item can be executed

Each build order index increment
    Add the current state to snapshots for cached view 
*/

let lastSnapshot = null
let mineralIncomeCache = {}
let vespeneIncomeCache = {}
const workerTypes = new Set(["SCV", "Probe", "Drone"])

class GameLogic {
    /**
     * 
     * @param {String} race - One of ["terran", "zerg", "protoss"] 
     * @param {Object[]} bo 
     * @param {String} bo[].name - Each build order element has a name, e.g. 'SCV'
     * @param {String} bo[].type - One of ["worker", "action", "unit", "structure", "upgrade"] 
     * @param {*} customSettings - See helper.js for default settings
     */
    constructor(race="terran", bo=[], customSettings=[]) {
        this.race = race
        this.bo = bo
        this.boIndex = 0
        this.minerals = 50
        this.vespene = 0
        this.supplyUsed = 12
        this.supplyLeft = this.race === "zerg" ? 2 : 3
        this.supplyCap = this.race === "zerg" ? 14 : 15
        // All units that are alive
        this.units = new Set()
        // Units that have a slot open to do something, e.g. a barracks with reactor will be idle if it only trains one marine
        this.idleUnits = new Set()
        // Units that have a task, a barracks with reactor that only trains one marine will be busy
        this.busyUnits = new Set()
        this.workersMinerals = 12
        this.workersVespene = 0
        this.workersScouting = 0
        this.muleCount = 0
        // Researched upgrades
        this.upgrades = new Set()
        // Amount of bases
        this.baseCount = 1
        // Amount of refineries, extractors, assimilators
        this.gasCount = 0
        this.freeTechlabs = 0
        this.freeReactors = 0
        this.frame = 0
        // Keep track of time for action 'do_nothing_5_sec'
        this.waitTime = 0
        // Keep track of how long all units were idle (waiting for resources)
        this.idleTime = 0
        this.eventLog = []
        // Number of units, will only be saved after every build order index advances - only used for UI purpose on the right side of the website
        this.unitsCount = {}

        // Custom settings from the settings page
        // How many seconds the worker mining should be delayed at game start
        this.workerStartDelay = 2
        // How many seconds a worker needs before starting to build a structure
        this.workerBuildDelay = 2
        // How many seconds a worker needs to return back to mining after completing a structure
        this.workerReturnDelay = 2
        // Allow max 40 seocnds frames for all units to be idle, before the game logic aborts and marks the build order as 'not valid' (cc off 12 workers can be started after 35 seconds)
        this.idleLimit = 40
        // HTML element width factor
        this.htmlElementWidthFactor = 0.3
        // How long it takes buildings to dettach from addons (lift, fly away and land)
        this.addonSwapDelay = 3

        // Update settings from customSettings object, see WebPage.js defaultSettings
        this.loadSettings(customSettings)
    }
    
    /**
     * Prepares default properties for this.setStart()
     */
    reset() {
        this.boIndex = 0
        this.minerals = 50
        this.vespene = 0
        this.supplyUsed = 12
        this.supplyLeft = this.race === "zerg" ? 2 : 3
        this.supplyCap = this.race === "zerg" ? 14 : 15
        this.units = new Set()
        this.idleUnits = new Set()
        this.busyUnits = new Set()
        this.workersMinerals = 0
        this.workersVespene = 0
        this.workersScouting = 0
        this.muleCount = 0
        this.upgrades = new Set()
        this.baseCount = 1
        this.gasCount = 0
        this.freeTechlabs = 0
        this.freeReactors = 0
        this.frame = 0
        this.waitTime = 0
        this.idleTime = 0
        this.eventLog = []
        this.unitsCount = {}
        lastSnapshot = null
    }

    /**
     * 
     * @param {Object} customSettings - See helper.js for default settings
     */
    loadSettings(customSettings) {
        for (let item of customSettings) {
            this[item.variableName] = item.v
        }
    }

    /**
     * 
     * @param {GameLogic} snapshot - A snapshot of the game logic
     */
    loadFromSnapshotObject(snapshot) {
        console.assert(snapshot, snapshot)
        // TODO Find a better way of overwriting values from snapshot
        console.log(cloneDeep(this));
        console.log(cloneDeep(snapshot));
        for (let key of Object.keys(snapshot)) {
            this[key] = cloneDeep(snapshot[key])
        }
    }

    /**
     * Returns a GameLogic object back
     */
    getLastSnapshot() {
        return lastSnapshot
    }

    /**
     * Sets the start conditions: spawns all start structures, starting resources and values will be set in this.reset()
     */
    setStart() {
        this.reset()
        let townhallName = ""
        let workerName = ""
        if (this.race === "terran") {
            townhallName = "CommandCenter"
            workerName = "SCV"
        }
        if (this.race === "protoss") {
            townhallName = "Nexus"
            workerName = "Probe"
        }
        if (this.race === "zerg") {
            townhallName = "Hatchery"
            workerName = "Drone"
        }
        const townhall = new Unit(townhallName)
        if (this.race === "zerg") {
            townhall.larvaCount = 3
        }
        this.units.add(townhall)
        this.idleUnits.add(townhall)
        for (let i = 0; i < 12; i++) {
            const unit = new Unit(workerName)
            // Add worker delay of 2 seconds before they start gathering minerals
            const workerStartDelayTask = new Task(22.4 * this.workerStartDelay, this.frame)
            workerStartDelayTask.addMineralWorker = true
            unit.addTask(this, workerStartDelayTask)
            this.units.add(unit)
        }
        this.updateUnitsCount()
    }

    /**
     * Runs the simulation until a limit is reached (20 minutes)
     * or until the end of build order is reached and no unit is busy (= no unit has a task)
     * or if no unit was busy for a long time, then it is assumed that the build order cannot be executed completely and must be invalid
     */
    runUntilEnd() {
        // Runs until all units are idle
        while (this.frame < 22.4 * 20 * 60) { // Limit to 20 mins
            this.runFrame()
            this.frame += 1
            // Abort once all units are idle and end of build order is reached
            if (this.boIndex >= this.bo.length && this.busyUnits.size === 0) {
                break
            }

            // Abort if units idle for too long (waiting for resources), e.g. when making all workers scout and only one more worker is mining, then build a cc will take forever
            if (this.busyUnits.size === 0) {
                this.idleTime += 1
                if (this.idleTime >= this.idleLimit * 22.4) {
                    break
                }
            } else {
                this.idleTime = 0
            }
        }
        // TODO better assertion statements
        // if bo is not valid and current item in bo requires more supply than we have left: tell user that we are out of supply
        // if bo item costs gas but no gas mining: tell user that we dont mine gas
        console.assert(this.boIndex >= this.bo.length, cloneDeep(this))
        // console.assert(this.boIndex >= this.bo.length, JSON.stringify(cloneDeep(this), undefined, 4))
        
        // Sort eventList by item.start, but perhaps the reverse is the desired behavior?
        this.eventLog.sort((a, b) => {
            if (a.start < b.start) {
                return -1
            } 
            if (a.start > b.start) {
                return 1
            }
            return 0
        })
    }

    /**
     * Executes one frame of the simulation
     * Adds income
     * Steps each unit by 1 frame (task progress, energy generation etc.)
     * Tries to execute next build order elements until it is no longer possible
     */
    runFrame() {
        // Run one frame in game logic
        this.addIncome()
        this.updateUnitsProgress()

        let endOfActions = false
        // Each frame could theoretically have multiple actions
        while (!endOfActions && this.boIndex < this.bo.length) {
            endOfActions = true
            const boElement = this.bo[this.boIndex]
            // Check requirements
            // Check idle unit who can train / produce / research / execute action

            // console.log(this.frame, this.boIndex, boElement);
            
            // Train unit
            if (["worker", "unit"].includes(boElement.type)) {
                const trained = this.trainUnit(boElement)
                if (trained) {
                    endOfActions = false
                }
            }

            // Build structures
            else if (boElement.type === "structure") {
                const built = this.trainUnit(boElement)
                if (built) {
                    endOfActions = false
                }
            }

            // Research upgrade
            else if (boElement.type === "upgrade") {
                const researched = this.researchUpgrade(boElement)
                if (researched) {
                    endOfActions = false
                }
            }

            // Run action
            else if (boElement.type === "action") {
                const executed = executeAction(this, boElement)
                if (executed) {
                    endOfActions = false
                }
            }

            if (!endOfActions) {
                // console.log(this.frame);
                this.boIndex += 1
                this.updateUnitsCount()
                // Each time the boIndex gets incremented, take a snapshot of the current state - this way i can cache the gamelogic and reload it from the state
                // e.g. bo = [scv, depot, scv]
                // and i want to remove depot, i can resume from cached state of index 0

                const clone = cloneDeep(this)
                // // Need to add one frame here
                clone.frame += 1
                lastSnapshot = clone
            }
        }
    }

    /**
     * Updates the statistics of available actions, how many units and structures we have, and what upgrades are researched
     */
    updateUnitsCount() {
        // Counts all available actions and how many units, structures we have and if an upgrade is researched
        this.unitsCount = {}
        const incrementUnitName = (item, amount=1) => {
            if (!this.unitsCount[item]) {
                this.unitsCount[item] = amount
            } else {
                this.unitsCount[item] += amount
            }
        }
        this.units.forEach((unit, index) => {
            incrementUnitName(unit.name)
            if (unit.hasTechlab) {
                incrementUnitName(`${unit.name}Techlab`)
            } else if (unit.hasReactor) {
                incrementUnitName(`${unit.name}Reactor`)
            }
            if (unit.larvaCount > 0) {
                incrementUnitName("Larva", unit.larvaCount)
            }
            if (unit.isMiningMinerals()) {
                // Amount of workers mining minerals
                incrementUnitName("worker_to_mins")
            }
            if (unit.isMiningGas) {
                // Amount of workers mining gas
                incrementUnitName("worker_to_gas")
            }
            if (unit.isScouting) {
                // Amount of scouting workers
                incrementUnitName("worker_to_scout")
            }
            if (unit.hasSupplyDrop) {
                incrementUnitName("call_down_supply")
            }
            // TODO Count actions by dividing energy through action energy cost, e.g. Math.floor(OC / 50) for amount of mule calldown available 
        })
        this.upgrades.forEach((upgrade, index) => {
            incrementUnitName(upgrade)
        })
    }

    /**
     * The simulation tries to train a unit, builds a structure or morphs a unit
     * @param {Object} unit - The build order element 
     * @param {String} unit.name - For example 'SCV'
     * @param {String} unit.type - The type of the build order item, one of ["worker", "action", "unit", "structure", "upgrade"] 
     */
    trainUnit(unit) {
        // Issue train command of unit type
        console.assert(unit.name, JSON.stringify(unit, null, 4))
        console.assert(unit.type, JSON.stringify(unit, null, 4))

        // Get cost (mineral, vespene, supply)
        if (!this.canAfford(unit)) {
            // console.log(this.frame, this.minerals, this.vespene);
            return false
        }

        // Get unit type / structure type that can train this unit
        const trainedInfo = TRAINED_BY[unit.name]
        console.assert(trainedInfo, unit.name)

        // Check if requirement is met
        const requiredStructure = trainedInfo.requiredStructure
        let requiredStructureMet = requiredStructure === null ? true : false
        if (!requiredStructureMet) {
            for (let structure of this.units) {
                if (structure.name === requiredStructure) {
                    requiredStructureMet = true
                    break
                } 
            }
            if (!requiredStructureMet) {
                return false
            }
        }

        // The unit/structure that is training the target unit or structure
        for (let trainerUnit of this.idleUnits) {
            console.assert(trainerUnit.name, trainerUnit)

            // Unit might no longer be idle while iterating over idleUnits
            if (!trainerUnit.isIdle()) {
                continue
            }

            // If target is an addon but building structure already has addon: skip
            if ((unit.name.includes("TechLab") || unit.name.includes("Reactor")) && trainerUnit.hasAddon()) {
                continue
            }

            // Loop over all idle units and check if they match unit type
            
            const trainerCanTrainThisUnit = trainedInfo.trainedBy.has(trainerUnit.name)
            const trainerCanTrainThroughReactor = !trainedInfo.requiresTechlab && trainerUnit.hasReactor //&& !unit.name.includes("TechLab") && !unit.name.includes("Reactor")
            // TODO Rename this task as 'background task' as probes are building structures in the background aswell as hatcheries are building stuff with their larva
            const trainerCanTrainThroughLarva = (trainedInfo.trainedBy.has("Larva") && trainerUnit.larvaCount > 0) || trainerUnit.name === "Probe"

            if (
                !trainerCanTrainThisUnit 
                && !trainerCanTrainThroughReactor 
                && !trainerCanTrainThroughLarva) {
                continue
            }
            
            // The trainerUnit can train the target unit

            // Add task to unit
            // If trained unit is made by worker: add worker move delay
            let buildTime = this.getTime(unit.name)
            
            // Create the build start delay task
            let buildStartDelay = 0
            if (workerTypes.has(trainerUnit.name)) {
                this.workersMinerals -= 1
                // Worker moving to location delay
                const workerMovingToConstructionSite = new Task(this.workerBuildDelay * 22.4, this.frame)
                trainerUnit.addTask(this, workerMovingToConstructionSite)
                buildStartDelay = this.workerBuildDelay * 22.4
            }

            // Create the new task
            const newTask = new Task(buildTime, this.frame + buildStartDelay)
            const morphCondition = (trainedInfo.isMorph || trainedInfo.consumesUnit) && !trainerCanTrainThroughLarva 
            newTask.morphToUnit = morphCondition || trainedInfo.consumesUnit ? unit.name : null
            if (newTask.morphToUnit === null) {
                if (unit.type === "worker") {
                    newTask.newWorker = unit.name
                } else if (unit.type === "unit") {
                    newTask.newUnit = unit.name
                } else if (unit.type === "structure") {
                    newTask.newStructure = unit.name
                }
            }
            trainerUnit.addTask(this, newTask, trainerCanTrainThroughReactor, trainerCanTrainThroughLarva)

            // Create the builder return task
            if (["Probe", "SCV"].includes(trainerUnit.name)) {
                // Probe and SCV return to mining after they are done with their task
                const workerReturnToMinerals = new Task(this.workerReturnDelay * 22.4, this.frame)
                workerReturnToMinerals.addMineralWorker = true
                trainerUnit.addTask(this, workerReturnToMinerals)
            }
            // TODO If trainerUnit is a worker: reduce mineral worker count by 1 and add it by 1 once the task is complete
            if (trainerCanTrainThroughLarva) {
                trainerUnit.larvaCount -= 1
            }

            const cost = this.getCost(unit.name)
            if (unit.name === "Zergling") {
                cost.supply = 1
                cost.minerals = 50
            }
            this.minerals -= cost.minerals
            this.vespene -= cost.vespene
            if (cost.supply > 0) {
                this.supplyUsed += cost.supply
                this.supplyLeft -= cost.supply
            }
            if (trainerUnit.name === "Drone") {
                this.supplyUsed -= 1
                this.supplyLeft += 1
            }            

            return true
        }
        return false
    }
    
    /**
     * The simulation tries to research an upgrade
     * Nearly the same as trainUnit(unit)
     * @param {Object} upgrade 
     * @param {String} upgrade.name 
     * @param {String} upgrade.type 
     */
    researchUpgrade(upgrade) {
        // Issue research command of upgrade type
        console.assert(upgrade.name, JSON.stringify(upgrade, null, 4))
        console.assert(upgrade.type, JSON.stringify(upgrade, null, 4))
        
        // Get cost (mineral, vespene, supply)
        if (!this.canAfford(upgrade)) {
            // console.log(this.frame, this.minerals, this.vespene);
            return false
        }

        // Get unit type / structure type that can train this unit
        const researchInfo = RESEARCHED_BY[upgrade.name]
        console.assert(researchInfo, researchInfo)
        
        // Check if requirement is met
        const requiredStructure = researchInfo.requiredStructure
        let requiredStructureMet = requiredStructure === null ? true : false
        if (!requiredStructureMet) {
            for (let structure of this.units) {
                if (structure.name === requiredStructure) {
                    requiredStructureMet = true
                    break
                } 
            }
            if (!requiredStructureMet) {
                return false
            }
        }

        const requiredUpgrade = researchInfo.requiredUpgrade
        let requiredUpgradeMet = requiredUpgrade === null ? true : false
        if (!requiredUpgradeMet) {
            if (this.upgrades.has(requiredUpgrade)) {
                requiredUpgradeMet = true
            }
            if (!requiredUpgradeMet) {
                return false
            }
        }
        
        // The unit/structure that is training the target unit or structure
        for (let researcherStructure of this.idleUnits) {
            console.assert(researcherStructure.name, researcherStructure)
            
            // Unit might no longer be idle while iterating over idleUnits
            if (!researcherStructure.isIdle()) {
                continue
            }
            
            const structureCanResearchUpgrade = researchInfo.researchedBy[researcherStructure.name] === 1
            if (!structureCanResearchUpgrade) {
                continue
            }
            
            // All requirement checks complete, start the task
            
            const researchTime = this.getTime(upgrade.name, true)
            const newTask = new Task(researchTime, this.frame)
            newTask.newUpgrade = upgrade.name
            researcherStructure.addTask(this, newTask)
            const cost = this.getCost(upgrade.name, true)
            this.minerals -= cost.minerals
            this.vespene -= cost.vespene
            return true
        }
        return false
    }

    /**
     * Updates the unit state and progress of all living units
     */
    updateUnitsProgress() {
        // Updates the energy on each unit and their task progress
        this.units.forEach((unit) => {
            unit.updateUnitState(this)
        })
        this.units.forEach((unit) => {
            const isAlive = unit.isAlive(this.frame)
            if (!isAlive) {
                if (unit.name === "MULE") {
                    this.muleCount -= 1
                } 
                this.killUnit(unit)
            }
        })
        this.units.forEach((unit) => {
            unit.updateUnit(this)
        })
    }

    // UTILITY FUNCTIONS

    /**
     * Kills a unit and removes it from the game logic
     * @param {Unit} unit 
     */
    killUnit(unit) {
        this.units.delete(unit)
        this.idleUnits.delete(unit)
        this.busyUnits.delete(unit)
    }

    /**
     * Gets the cost of a unit, structure, morph or upgrade
     * @param {String} unitName 
     * @param {Boolean} isUpgrade 
     */
    getCost(unitName, isUpgrade=false) {
        // Gets cost of unit, structure or upgrade
        // TODO get cost of upgrade
        if (isUpgrade) {
            console.assert(UPGRADES_BY_NAME[unitName], `${unitName}`)
            return {
                minerals: UPGRADES_BY_NAME[unitName].cost.minerals,
                vespene: UPGRADES_BY_NAME[unitName].cost.gas,
                supply: 0,
            }
        }
        console.assert(UNITS_BY_NAME[unitName], `${unitName}`)
        return {
            minerals: UNITS_BY_NAME[unitName].minerals,
            vespene: UNITS_BY_NAME[unitName].gas,
            supply: UNITS_BY_NAME[unitName].supply,
        }
    }
    
    /**
     * Gets build or research time of a unit, structure, morph or upgrade
     * @param {String} unitName 
     * @param {Boolean} isUpgrade 
     */
    getTime(unitName, isUpgrade=false) {
        // Get build time of unit or structure, or research time of upgrade (in frames)
        // TODO get time of upgrade
        if (isUpgrade) {
            console.assert(UPGRADES_BY_NAME[unitName], `${unitName}`)
            return UPGRADES_BY_NAME[unitName].cost.time
        }
        console.assert(UNITS_BY_NAME[unitName], `${unitName}`)
        return UNITS_BY_NAME[unitName].time
    }
    
    /**
     * Calculates and caches the income based on how many workers (and mules), bases and gas structures we have
     */
    addIncome() {
        // Calculate income based on mineral and gas workers
        let minerals = mineralIncomeCache[[this.workersMinerals, this.baseCount, this.muleCount]]
        if (minerals === undefined) {
            minerals = incomeMinerals(this.workersMinerals, this.baseCount, this.muleCount) / 22.4
            mineralIncomeCache[[this.workersMinerals, this.baseCount, this.muleCount]] = minerals
        } 

        let vespene = vespeneIncomeCache[[this.workersVespene, this.gasCount]]
        if (vespene === undefined) {
            vespene = incomeVespene(this.workersVespene, this.gasCount) / 22.4
            vespeneIncomeCache[[this.workersVespene, this.gasCount]] = vespene
        } 
        this.minerals += minerals
        this.vespene += vespene
        // this.minerals += incomeMinerals(this.workersMinerals, this.baseCount, this.muleCount) / 22.4
        // this.vespene +=  incomeVespene(this.workersVespene, this.gasCount) / 22.4
    }

    /**
     * @param {Object} unit 
     * @param {String} unit.name
     * @param {String} unit.type 
     */
    canAfford(unit) {
        // Input: unit or upgrade object {name: "SCV", type: "worker"}
        console.assert(unit.name, JSON.stringify(unit, null, 4))
        console.assert(unit.type, JSON.stringify(unit, null, 4))
        if (unit.type === "upgrade") {
            return this._canAfford(this.getCost(unit.name, true))
        } else {
            return this._canAfford(this.getCost(unit.name, false))
        }
    }

    /**
     * @param {Object} cost 
     * @param {Number} cost.minerals 
     * @param {Number} cost.vespene 
     * @param {Number} cost.supply 
     */
    _canAfford(cost) {
        // Input: cost object
        console.assert(cost.minerals, JSON.stringify(cost, null, 4))
        if (cost.minerals <= this.minerals && cost.vespene <= this.vespene && (cost.supply < 0 || cost.supply <= this.supplyLeft)) {
            return true
        }
        return false
    }
    
}


export {Event, GameLogic}

