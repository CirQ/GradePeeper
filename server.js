
const assert = require('assert')

const cheerio = require('cheerio')
const qrcodeterminal = require('qrcode-terminal')
const superagent = require('superagent')
const { Wechaty, log } = require('wechaty')
const { MemoryCard } = require('memory-card')
const { PuppetMock } = require('wechaty-puppet-mock')
// const { PuppetPadplus } = require('wechaty-puppet-padplus')

const config = require('./config')


class SystemProber {
    constructor(jsessionid, courses) {
        this.jsessionid = jsessionid
        this.courses = courses
    }

    static async make(jsessionid, courses){
        const jid = this._validate_cookie(jsessionid)
        const crs = courses.map(cid => cid.toUpperCase())
        return new SystemProber(jid, crs)
    }

    static async _validate_cookie(jsessionid) {
        // todo!!!
        return jsessionid
    }

    async _handleResponse(text) {
        let results = []
        let self = this
        let $ = cheerio.load(text)
        $('#table_cjxx>tbody>.t_con').each(function() {
            const cid = $(this).find(':nth-child(2)').text().trim()
            if(self.courses.includes(cid)){
                results.push({
                    cid: cid,
                    name: $(this).find(':nth-child(3)').text().trim(),
                    grade: +$(this).find(':nth-child(6)').text(),
                    gpa: +$(this).find(':nth-child(7)').text(),
                    status: $(this).find(':nth-child(8)').text().trim(),
                })
            }
        })
        return results
    }

    async probe() {
        try {
            var res = await superagent
                .get('http://gradinfo.sustech.edu.cn/ssfw/pygl/cjgl/cjcx.do')
                .set('Cookie', 'JSESSIONID='+this.jsessionid)
                .send();
            if(res.status == 200) {
                return this._handleResponse(res.text)
            }
            else {
                console.error('not OK status: ' + res.status)
            }
        } catch (err) {
            console.error('request with error: ' + err)
        }
        return null
    }
}



class WechatyServer {

    async check(fromId, msger){
        const jsessionid = config.cookie_jsessionid
        const courses = config.courseid_interested

        const pb = new SystemProber(jsessionid, courses)
        var result = await pb.probe()
        result.forEach((gitem) => {

            if(isNaN(gitem.grade)) {
                const { name, cid } = gitem;
                msger.say(`【${name}/${cid}】还没有出分数哦~`)
            }
            else {
                const { name, cid, grade, gpa, status } = gitem;
                msger.say(`【${name}/${cid}】\n` +
                        `分数：${grade}\n` +
                        `折合绩点：${gpa}\n` +
                        `是否及格：${(status==='及格')&&'是' || '否'}`)
            }

        });
    }

    async onMessage(msg, payload) {
        if(payload.toId != this.wxid){
            // send from myself
            assert.equal(payload.fromId, this.wxid)
            return
        }
        if(payload.type != 7)   // not text
            return

        const { fromId, text } = payload;
        switch(text) {
            case 'mock text test':
                this.check(fromId, msg)
                break;
        }
    }

    constructor(name='checker') {
        const DEFAULT_PUPPET = true
        if(DEFAULT_PUPPET) {
            this.bot = new Wechaty({ name: name })
        }
        else{
            const puppet = new PuppetMock({ memory: new MemoryCard() })
            // const ppp = new
            this.bot = new Wechaty({ name: name, puppet: puppet })
        }
        this.wxid = ''
    }

    init() {
        this.bot.on('scan', (qrcode, status) => {
            // when prompting bot-owner to login
            console.log(`Scan QR Code to login: ${status}`)
            // console.log('https://api.qrserver.com/v1/create-qr-code/?data='+encodeURIComponent(qrcode))
            qrcodeterminal.generate(qrcode, {small:true})
        })
        this.bot.on('login', user => {
            // when user successfully logined
            this.wxid = user.id
            console.log(`User ${user} logined`)
        })
        this.bot.on('message', async message => {
            // when got message
            await this.onMessage(message, message.payload)
        })
        this.bot.on('friendship', friendship => {
            // when receive friend request
            console.log(`Friendship: ${friendship}`)
        })
        // non sense
        // this.bot.on('heartbeat', data => {
        //     console.log(`Got heartbeat: ${data}`)
        // })
        return this.bot
    }



}

new WechatyServer().init()
    .start()
    .then(() => log.info('CheckerBot', 'Checker-Bot Started.'))
    .catch(err => log.error('CheckerBot', err))
