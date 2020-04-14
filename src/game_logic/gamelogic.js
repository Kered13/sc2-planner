import UNITS_BY_NAME from "../constants/units_by_name"
import TRAINED_BY from "../constants/trained_by"
import UPGRADES_BY_NAME from "../constants/upgrade_by_name"
// import RESEARCHED_BY from "../constants/researched_by"
// import {CUSTOMACTIONS} from "../constants/customactions"
import {incomeMinerals, incomeVespene} from "./income"

import {cloneDeep} from 'lodash'

const UNIT_ICONS = require("../icons/unit_icons.json")
// const UPGRADE_ICONS = require("../icons/upgrade_icons.json")

/** Logic of this file:
Each frame
    Calculate and add income
    Update the state of each unit:
        Update energy available
        Update progress (if they are doing something)
    Check if the next build order item can be executed
Each second (22.4 frames): 
    Add the current state to the object for cached view 
*/


/** TODO
Upgrades
custom actions
*/

let currentId = 0
const getUnitId = () => {
    currentId += 1
    return currentId
}

class Event {
    constructor(name, imageSource, type, start, end) {
        this.name = name
        this.imageSource = imageSource
        this.type = type
        this.start = start
        this.end = end
    }
}

class Task {
    constructor(totalFramesRequired=0, startFrame=0) {
        // Once progress reaches 1, the task is supposed to be removed and the unit ends up idle
        // How much total progress is required
        this.totalFramesRequired = totalFramesRequired
        this.startFrame = startFrame
        // Automatically set by updateProgress
        this.progress = 0
        this.isCompleted = false
        this.newWorker = null
        this.newUnit = null
        this.newStructure = null
        this.newUpgrade = null
        this.morphToUnit = null
        this.addsTechlab = false
        this.addsReactor = false
    }

    updateProgress(hasChrono=false) {
        if (hasChrono) {
            this.progress += 1.5
        } else {
            this.progress += 1
        }
        if (this.progress >= this.totalFramesRequired) {
            this.isCompleted = true
        }
    }
}

class Unit { 
    constructor(name) {
        this.name = name
        this.id = getUnitId()
        this.energy = 0
        this.tasks = []
        // Protoss train and research structures
        this.hasChronoUntilFrame = 0
        // Zerg townhalls
        this.hasInjectUntilFrame = 0
        this.nextLarvaSpawn = -1
        this.larvaCount = 0
        this.larvaTasks = []
        // Terran depot
        this.hasSupplyDrop = false
        // Terran production structures
        this.hasTechlab = false
        this.hasReactor = false
        this.reactorTasks = []
    }

    /**
     * 
     * @param {Task} task 
     * @param {boolean} taskForReactor 
     * @param {boolean} taskForLarva 
     */
    addTask(task, taskForReactor=false, taskForLarva=false) {
        console.assert([true, false].includes(taskForReactor), taskForReactor)
        console.assert([true, false].includes(taskForLarva), taskForLarva)
        
        if (taskForReactor) {
            this.reactorTasks.push(task)
            return
        }
        if (taskForLarva) {
            this.larvaTasks.push(task)
            return
        }
        this.tasks.push(task)
    }

    isIdle() {
        // Returns true if it has no tasks, or has reactor and reactor has no tasks, or has larva
        return this.tasks.length === 0 || (this.hasReactor && this.reactorTasks.length === 0) || this.larvaCount > 0
    }
    
    isBusy() {
        // Returns true it has a task (hatchery builds queen, or hatchery's larva builds drone, or barrack's reactor builds a marine)
        return this.tasks.length > 0 || (this.hasReactor && this.reactorTasks.length > 0) || this.larvaTasks.length > 0
    }

    hasChrono(gamelogic) {
        return this.hasChronoUntilFrame <= this.frame
    }

    addChrono(frame) {
        this.hasChronoUntilFrame = frame + 20 * 22.4
    }

    updateUnitState(gamelogic) {
        // Should be called every frame for each unit

        // Energy per frame
        this.energy = Math.min(200, this.energy + 0.03515625)

        // If is zerg townhall: generate new larva
        if (["Hatchery", "Lair", "Hive"].includes(this.name)) {
            // If at max larva, dont generate new one until 11 secs elapsed
            if (this.larvaCount >= 3) {
                this.nextLarvaSpawn = gamelogic.frame + 11 * 22.4
            }
            
            if (this.nextLarvaSpawn < gamelogic.frame) {
                this.larvaCount += 1
                this.nextLarvaSpawn = gamelogic.frame + 11 * 22.4
            }
            
            // If has inject: spawn larva when frame has been reached
            if (Math.round(this.hasInjectUntilFrame) === gamelogic.frame) {
                this.larvaCount += 3
            }
        }
    }
    
    updateTask(gamelogic, task) {
        // Task is a task class instance

        // TODO If structure has reactor: progress reactor-task too
        task.updateProgress(this.hasChrono())
        // Remove first task if completed
        if (task.isCompleted) {
            // Spawn worker
            if (task.newWorker !== null) {
                const newUnit = new Unit(task.newWorker)
                // TODO Add worker spawn delay and add them to busy units instead of idle units
                gamelogic.units.add(newUnit)
                gamelogic.idleUnits.add(newUnit)
                gamelogic.workersMinerals += 1
                // console.log(gamelogic.frame);
                // console.log(newUnit);
                gamelogic.eventLog.push(new Event(
                    newUnit.name, UNIT_ICONS[newUnit.name.toUpperCase()], "worker", task.startFrame, gamelogic.frame
                ))
            }
            // Spawn unit
            if (task.newUnit !== null) {
                const newUnit = new Unit(task.newUnit)
                newUnit.energy = 50
                gamelogic.units.add(newUnit)
                gamelogic.idleUnits.add(newUnit)
                // console.log(gamelogic.frame);
                // console.log(newUnit);
                gamelogic.eventLog.push(new Event(
                    newUnit.name, UNIT_ICONS[newUnit.name.toUpperCase()], "unit", task.startFrame, gamelogic.frame
                ))
                const unitData = UNITS_BY_NAME[task.newUnit]
                // Overlord finishes, overlord will have -8 supply
                if (unitData.supply < 0) {
                    gamelogic.supplyCap += -unitData.supply
                    gamelogic.supplyCap = Math.min(200, gamelogic.supplyCap)
                    gamelogic.supplyLeft = gamelogic.supplyCap - gamelogic.supplyUsed
                }
            }
            // Spawn structure
            if (task.newStructure !== null) {
                const newUnit = new Unit(task.newStructure)
                newUnit.energy = 50
                gamelogic.units.add(newUnit)
                gamelogic.idleUnits.add(newUnit)
                // Structure that gives supply finishes, structure will have -X supply
                const unitData = UNITS_BY_NAME[task.newStructure]
                if (unitData.supply < 0) {
                    gamelogic.supplyCap += -unitData.supply
                    gamelogic.supplyCap = Math.min(200, gamelogic.supplyCap)
                    gamelogic.supplyLeft = gamelogic.supplyCap - gamelogic.supplyUsed
                }
                // console.log(gamelogic.frame);
                // console.log(newUnit);
                gamelogic.eventLog.push(new Event(
                    newUnit.name, UNIT_ICONS[newUnit.name.toUpperCase()], "structure", task.startFrame, gamelogic.frame
                ))
                
            }
            // Mark upgrade as researched
            if (task.newUpgrade !== null) {
                const newUpgrade = new Unit(task.newUpgrade)
                // gamelogic.units.add(newUpgrade)
                // gamelogic.idleUnits.add(newUpgrade)

                gamelogic.eventLog.push(new Event(
                    newUpgrade.name, UNIT_ICONS[newUpgrade.name.toUpperCase()], "upgrade", task.startFrame, gamelogic.frame
                ))
            }
            // Morph to unit
            if (task.morphToUnit !== null) {
                this.name = task.morphToUnit
                this.energy = 50

                const targetUnit = UNITS_BY_NAME[task.morphToUnit]
                const eventType = targetUnit.is_structure ? "structure" : "unit"
                gamelogic.eventLog.push(new Event(
                    targetUnit.name, UNIT_ICONS[targetUnit.name.toUpperCase()], eventType, task.startFrame, gamelogic.frame
                ))
            } 
            // Task is complete, mark for removal
            return true
        }
        return false
    }

    updateUnit(gamelogic) {
        // Should be called every for each busy unit (tasks.length + reactortasks.length > 0)

        // const wasIdle = this.isIdle()
        // const wasBusy = this.isBusy()

        // Update normal unit task
        if (this.tasks.length > 0) {
            const taskCompleted = this.updateTask(gamelogic, this.tasks[0])
            if (taskCompleted) {
                this.tasks.shift()
            }
        }
        // Update the task of the unit's reactor
        if (this.reactorTasks.length > 0) {
            const taskCompleted = this.updateTask(gamelogic, this.reactorTasks[0])
            if (taskCompleted) {
                this.reactorTasks.shift()
            }
        }
        // Larva is linked to the zerg townhalls: update all of them
        this.larvaTasks.forEach((task) => {
            this.updateTask(gamelogic, task)
        })
        // Remove completed tasks
        this.larvaTasks = this.larvaTasks.filter((item) => {
            return !item.isCompleted
        })

        // TODO expire chrono

        // Turn units idle if they have no more tasks (or reactor has no task or there is larva), and vice versa
        // if (!wasIdle && this.isIdle()) {
        //     gamelogic.idleUnits.add(this)
        // } else if (wasIdle && !this.isIdle()) {
        //     gamelogic.idleUnits.delete(this)
        // }
        if (this.isIdle()) {
            gamelogic.idleUnits.add(this)
        } else {
            gamelogic.idleUnits.delete(this)
        }
        // TODO Dont know which saves time, if is idle: keep adding, if not idle: keep deleting? or keep it like this?

        // Turn busy if was previously not busy, and vice versa
        // if (!wasBusy && this.isBusy()) {
        //     gamelogic.busyUnits.add(this)
        // } else if (wasBusy && !this.isBusy()) {
        //     gamelogic.busyUnits.delete(this)
        // }
        if (this.isBusy()) {
            gamelogic.busyUnits.add(this)
        } else {
            gamelogic.busyUnits.delete(this)
        }
    }
}

// let frameSnapshots = {}
let boSnapshots = {}
let mineralIncomeCache = {}
let vespeneIncomeCache = {}

class GameLogic {
    constructor(race="terran", bo=[], customSettings=[]) {
        this.race = race
        this.bo = bo
        this.boIndex = 0
        this.minerals = 50
        this.vespene = 0
        this.supplyUsed = 12
        this.supplyLeft = this.race === "zerg" ? 2 : 3
        this.supplyCap = this.race === "zerg" ? 14 : 15
        this.units = new Set()
        this.idleUnits = new Set()
        this.busyUnits = new Set()
        this.workersMinerals = 12
        this.workersVespene = 0
        this.muleCount = 0
        this.baseCount = 1
        this.gasCount = 0
        this.frame = 0
        // Keep track of how long all units were idle (waiting for resources)
        this.idleTime = 0
        this.eventLog = []

        // Custom settings from the settings page
        // TODO
        // How many seconds the worker mining should be delayed at game start
        this.workerStartDelay = 2
        // How many seconds a worker needs before starting to build a structure
        this.workerBuildDelay = 2
        // How many seconds a worker needs to return back to mining after completing a structure
        this.workerReturnDelay = 2
        // Allow max 40 seocnds frames for all units to be idle, before the game logic aborts and marks the build order as 'not valid' (cc off 12 workers can be started after 35 seconds)
        this.idleLimit = 40 * 22.4
        // HTML element width factor
        this.htmlElementWidthFactor = 0.3
        // this.htmlElementWidthFactor = 1

        // Update settings from customSettings object, see WebPage.js defaultSettings
        for (let item of customSettings) {
            this[item.variableName] = item.value
        }
    }
    
    reset() {
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
        this.baseCount = 1
        this.gasCount = 0
        this.frame = 0
        this.eventLog = []
        // frameSnapshots = {}
        boSnapshots = {}
    }

    hasSnapshot() {
        return Object.keys(this.getBOIndexSnapshots()).length > 0
    }

    getBOIndexSnapshots() {
        return boSnapshots
    }

    loadFromSnapshotObject(snapshot) {
        console.assert(snapshot !== undefined, snapshot)
        this.boIndex = snapshot.boIndex
        this.minerals = snapshot.minerals
        this.vespene = snapshot.vespene
        this.supplyUsed = snapshot.supplyUsed
        this.supplyLeft = snapshot.supplyLeft
        this.supplyCap = snapshot.supplyCap
        this.units = snapshot.units
        this.idleUnits = snapshot.idleUnits
        this.busyUnits = snapshot.busyUnits
        this.workersMinerals = snapshot.workersMinerals
        this.workersVespene = snapshot.workersVespene
        this.baseCount = snapshot.baseCount
        this.gasCount = snapshot.gasCount
        this.frame = snapshot.frame
        this.eventLog = snapshot.eventLog
    }

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
            // TODO add 3 larva for zerg
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
            unit.addTask(workerStartDelayTask)
            this.units.add(unit)
            this.busyUnits.add(unit)
        }
    }

    runUntilEnd() {
        // Runs until all units are idle
        // TODO
        // while (this.frame < 22.4 * 1 * 60) { // Limit to 20 mins
        while (this.frame < 22.4 * 20 * 60) { // Limit to 20 mins
            // frameSnapshots[this.frame] = cloneDeep(this)

            // frameSnapshots[this.frame].units.forEach((item) => {
            //     if (item.tasks.length > 0 && this.frame == 200) {
            //         console.log(item);
            //         console.log(item.tasks[0]);
            //     }
            // })

            
            this.runFrame()
            this.frame += 1
            // Abort once all units are idle and end of build order is reached
            if (this.boIndex >= this.bo.length && this.busyUnits.size === 0) {
                break
            }

            // Abort if units idle for too long (waiting for resources), e.g. when making all workers scout and only one more worker is mining, then build a cc will take forever
            if (this.busyUnits.size === 0) {
                this.idleTime += 1
                if (this.idleTime >= this.idleLimit) {
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
        // TODO sort eventList by item.start 
    }

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
                this.researchUpgrade(boElement)
            }

            // Run action
            else if (boElement.type === "action") {
                this.executeAction(boElement)
            }

            if (!endOfActions) {
                // console.log(this.frame);
                this.boIndex += 1
                // Each time the boIndex gets incremented, take a snapshot of the current state - this way i can cache the gamelogic and reload it from the state
                // e.g. bo = [scv, depot, scv]
                // and i want to remove depot, i can resume from cached state of index 0
                const clone = cloneDeep(this)
                // Need to add one frame here
                clone.frame += 1
                boSnapshots[this.boIndex] = clone
            }
        }
    }

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
        // The unit/structure that is training the target unit or structure
        for (let trainerUnit of this.idleUnits) {
            if (!trainerUnit.isIdle()) {
                continue
            }
            // const unitName = unit.name

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
            }
            if (!requiredStructureMet) {
                return false
            }

            // Loop over all idle units and check if they match unit type
            // TODO If this is a barracks and has reactor: build from reactor if reactor is idle
            // TODO could be a morph, then just morph current unit
            
            
            const trainerCanTrainThisUnit = trainedInfo.trainedBy[trainerUnit.name] === 1
            // TODO Reactor builds units
            const trainerCanTrainThroughReactor = false
            const trainerCanTrainThroughLarva = trainedInfo.trainedBy["Larva"] === 1 && trainerUnit.larvaCount > 0
            // console.log(this.frame);
            // console.log(trainerUnit.name);
            // console.log(trainedInfo);
            // console.log(trainerCanTrainThisUnit);
            // console.log(trainerCanTrainThroughLarva);
            if (!trainerCanTrainThisUnit && !trainerCanTrainThroughLarva) {
                continue
            }
            
            // The trainerUnit can train the target unit

            // Add task to unit
            // If trained unit is made by worker: add worker move delay
            const buildTime = this.getTime(unit.name)
            
            const newTask = new Task(buildTime, this.frame)
            newTask.morphToUnit = trainedInfo.isMorph || trainedInfo.consumesUnit ? unit.name : null
            
            if (newTask.morphToUnit === null) {
                if (unit.type === "worker") {
                    newTask.newWorker = unit.name
                } else if (unit.type === "unit") {
                    newTask.newUnit = unit.name
                } else if (unit.type === "structure") {
                    newTask.newStructure = unit.name
                }
            }
            console.log(trainedInfo);
            // console.log(newTask);
            trainerUnit.addTask(newTask, trainerCanTrainThroughReactor, trainerCanTrainThroughLarva)
            // Unit is definitely busy after receiving a task
            this.busyUnits.add(trainerUnit)
            if (trainerCanTrainThroughLarva) {
                trainerUnit.larvaCount -= 1
            }
            // If unit has reactor, might still be idle
            // console.log(cloneDeep(trainerUnit));
            
            // console.log(this.frame);
            // console.log(cloneDeep(unit));
            // console.log(cloneDeep(trainerUnit));
            // console.log(cloneDeep(trainedInfo));
            // console.log(cloneDeep(newTask));

            const cost = this.getCost(unit.name)
            this.minerals -= cost.minerals
            this.vespene -= cost.vespene
            if (cost.supply > 0) {
                this.supplyUsed += cost.supply
                this.supplyLeft -= cost.supply
            }

            return true
        }
        return false
    }
    
    researchUpgrade(upgrade) {
        // Issue research command of upgrade type
        console.assert(upgrade.name, JSON.stringify(upgrade, null, 4))
        console.assert(upgrade.type, JSON.stringify(upgrade, null, 4))
        // TODO
        return true
    }
    
    executeAction(action) {
        // Issue action
        // TODO
        return true
    }

    updateUnitsProgress() {
        // Updates the energy on each unit and their task progress
        this.units.forEach((unit) => {
            unit.updateUnitState(this)
            unit.updateUnit(this)
        })
        // this.busyUnits.forEach((unit) => {
        // })
    }

    getCost(unitName, isUpgrade=false) {
        // Gets cost of unit, structure or upgrade
        // TODO get cost of upgrade
        if (isUpgrade) {
            console.assert(UPGRADES_BY_NAME[unitName], `${unitName}`)
            return {
                minerals: UPGRADES_BY_NAME[unitName].minerals,
                vespene: UPGRADES_BY_NAME[unitName].gas,
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
    
    getTime(unitName, isUpgrade=false) {
        // Get build time of unit or structure, or research time of upgrade (in frames)
        // TODO get time of upgrade
        if (isUpgrade) {
            console.assert(UPGRADES_BY_NAME[unitName], `${unitName}`)
            return UPGRADES_BY_NAME[unitName].time
        }
        console.assert(UNITS_BY_NAME[unitName], `${unitName}`)
        return UNITS_BY_NAME[unitName].time
    }
    
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

