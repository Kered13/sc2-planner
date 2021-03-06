import React, { Component } from "react"
import CLASSES from "../constants/classes"

import { getImageOfItem } from "../constants/helper"
import { GameLogic } from "../game_logic/gamelogic"
import { DragDropContext, Droppable, Draggable } from "react-beautiful-dnd"
import {
    IBuildOrderElement,
    ISettingsElement,
    IAllRaces,
} from "../constants/interfaces"

// A function to help us with reordering the result
// https://www.npmjs.com/package/react-beautiful-dnd
// Stolen from the horizontal list example https://github.com/atlassian/react-beautiful-dnd/blob/HEAD/docs/about/examples.md
const reorder = (
    list: Array<IBuildOrderElement>,
    startIndex: number,
    endIndex: number
) => {
    const result = Array.from(list)
    const [removed] = result.splice(startIndex, 1)
    result.splice(endIndex, 0, removed)

    return result
}

interface MyProps {
    gamelogic: GameLogic
    hoverIndex: number
    removeClick: (
        e: React.MouseEvent<HTMLDivElement, MouseEvent>,
        index: number
    ) => void
    rerunBuildOrder: (
        race: IAllRaces | undefined,
        buildOrder: IBuildOrderElement[],
        settings: ISettingsElement[] | undefined
    ) => void
    updateUrl: (
        race: IAllRaces | undefined,
        buildOrder: IBuildOrderElement[],
        settings: ISettingsElement[] | undefined
    ) => void
    changeHoverIndex: (index: number) => void
}

interface MyState {
    items: Array<IBuildOrderElement>
}

export default class BuildOrder extends Component<MyProps, MyState> {
    /**
     * Lists the tooltip order
     * If a build order item is pressed, remove it and recalculate the events in WebPage.js
     * If dragged, reorder the build order and then update game logic in WebPage.js
     */
    constructor(props: MyProps) {
        super(props)
        this.onDragEnd = this.onDragEnd.bind(this)
    }

    onMouseEnter(index: number) {
        this.props.changeHoverIndex(index)
    }
    onMouseLeave() {
        this.props.changeHoverIndex(-1)
    }

    onDragEnd(result: any) {
        // Dropped outside the list
        if (!result.destination) {
            return
        }

        const items: Array<IBuildOrderElement> = reorder(
            this.props.gamelogic.bo,
            result.source.index,
            result.destination.index
        )

        this.props.rerunBuildOrder(
            this.props.gamelogic.race,
            items,
            this.props.gamelogic.exportSettings()
        )

        this.props.updateUrl(
            this.props.gamelogic.race,
            items,
            this.props.gamelogic.exportSettings()
        )
    }

    render() {
        // Convert build order items to div elements

        // Hide element if no build order items are present
        if (this.props.gamelogic.bo.length === 0) {
            return ""
        }

        const buildOrder = this.props.gamelogic.bo.map((item, index) => {
            const image = getImageOfItem(item)
            return <img src={image} alt={item.name} />
        })

        const getItemClass = (dragging: boolean, index: number) => {
            // Build order is invalid after this index, mark background or border red
            // Set color based on if it is dragging
            if (dragging) {
                if (index >= this.props.gamelogic.boIndex) {
                    return CLASSES.boItemInvalidDragging
                }
                return CLASSES.boItemDragging
            } else if (index === this.props.hoverIndex) {
                return CLASSES.boItemHighlighting
            } else {
                if (index >= this.props.gamelogic.boIndex) {
                    return CLASSES.boItemInvalid
                }
                return CLASSES.boItem
            }
        }

        return (
            <div className={CLASSES.bo}>
                <DragDropContext onDragEnd={this.onDragEnd}>
                    <Droppable droppableId="droppable" direction="horizontal">
                        {(provided, snapshot) => (
                            <div
                                className="flex flex-shrink-0"
                                ref={provided.innerRef}
                                {...provided.droppableProps}
                            >
                                {this.props.gamelogic.bo.map((item, index) => (
                                    <Draggable
                                        key={`${index}`}
                                        draggableId={`${index}`}
                                        index={index}
                                    >
                                        {(provided, snapshot) => (
                                            <div
                                                ref={provided.innerRef}
                                                {...provided.draggableProps}
                                                {...provided.dragHandleProps}
                                                className={getItemClass(
                                                    snapshot.isDragging,
                                                    index
                                                )}
                                                onMouseEnter={(e) =>
                                                    this.onMouseEnter(index)
                                                }
                                                onMouseLeave={(e) =>
                                                    this.onMouseLeave()
                                                }
                                                onClick={(e: any) => {
                                                    this.props.removeClick(
                                                        e,
                                                        index
                                                    )
                                                }}
                                            >
                                                {buildOrder[index]}
                                            </div>
                                        )}
                                    </Draggable>
                                ))}
                                {provided.placeholder}
                            </div>
                        )}
                    </Droppable>
                </DragDropContext>
            </div>
        )
    }
}
