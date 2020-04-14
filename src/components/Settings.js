import React, { Component } from 'react'
import CLASSES from "../constants/classes"

export default class Settings extends Component {
    /**
     * A small settings menu to enable and disable things
     * And to be able to adjust certain sizes
     */
    constructor(props) {
        super(props)
        this.state = {
            show: false
        }
    }

    showSettings = (e) => {
        this.setState({
            show: true
        })
    }

    hideSettings = (e) => {
        this.setState({
            show: false
        })
    }

    render() {
        const classes = CLASSES.dropDown
        const classesAll = this.state.show ? `visible ${classes}` : `hidden ${classes}`

        const settingsElements = this.props.settings.map((item, index) => {
            return (
                // TODO let this value actually be changed: add onChange event which triggers a function in this.props.settingsChange()
                <div key={index} className={CLASSES.dropDownContainer}>
                    <div className={CLASSES.dropDownLabel}>
                        {item.name}
                    </div>
                    <input className={CLASSES.dropDownInput} type="number" placeholder={item.value} defaultValue={item.value} />
                </div>
            )
        })

        const settingsButton = 
            <div className={CLASSES.buttons} onMouseEnter={this.showSettings} onMouseLeave={this.hideSettings}>
                Settings
                <div className={classesAll}>
                    {settingsElements}
                </div>
            </div>
        return (
            <div>
                {settingsButton}
            </div>
        )
    }
}