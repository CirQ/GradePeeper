
const assert = require('assert')

const cheerio = require('cheerio')
const qrcodeterminal = require('qrcode-terminal')
const redis = require('async-redis')
const superagent = require('superagent')
const { Wechaty, log } = require('wechaty')
const { MemoryCard } = require('memory-card')
const { PuppetMock } = require('wechaty-puppet-mock')
// const { PuppetPadplus } = require('wechaty-puppet-padplus')

const config = require('./config')

const client = redis.createClient(config.redis_url)

class SystemProber {
    constructor(wxid, jsessionid, courses) {
        this.wxid = wxid
        this.jsessionid = jsessionid
        this.courses = courses
    }

    static async obtain(wxid){
        const jsessionid = await client.get(`JSESSIONID#${wxid}`)
        const jid = await this._validate_cookie(jsessionid)
        const crs = await client.smembers(`COURSES#${wxid}`)
        return new SystemProber(wxid, jid, crs)
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
                self.courses = self.courses.filter(x => x!==cid)
            }
        })
        return results
    }

    async probe(msger) {
        try {
            var res = await superagent
                .get('http://gradinfo.sustech.edu.cn/ssfw/pygl/cjgl/cjcx.do')
                .set('Cookie', `JSESSIONID=${this.jsessionid}`)
                .send();
            if(res.status == 200) {
                let result = this._handleResponse(res.text)
                if(this.courses.length) {
                    msger.say(`Unknown Course [${this.courses}] Remove`)
                    const key = `COURSES#${this.wxid}`
                    this.courses.forEach(x => client.srem(key, x))
                }
                return result
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

    async _check(fromId, msger) {
        const pb = await SystemProber.obtain(fromId)
        var result = await pb.probe(msger)
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

    async _register(fromId, msger) {
        const key = `JSESSIONID#${fromId}`
        const exist = await client.exists(key)
        if(exist) {
            msger.say('已经注册过啦！')
        }
        else {
            client.set(key, 'salty')
            msger.say('注册成功啦！')
        }
    }

    async _showall(fromId, msger) {
        const cset = await client.smembers(`COURSES#${fromId}`)
        if(cset) {
            cset.sort()
            msger.say('已经关注的课程编号：\n' + cset.join('\n'))
        }
        else {
            msger.say('还没有关注任何课程哦~')
        }
    }

    async _add(fromId, courseId, msger) {
        const key = `COURSES#${fromId}`
        const exist = await client.sismember(key, courseId)
        if(exist) {
            msger.say(`已经关注过${courseId}啦！`)
        }
        else {
            client.sadd(key, courseId)
            msger.say(`成功关注${courseId}啦！`)
        }
    }
    
    async _drop(fromId, courseId, msger) {
        const key = `COURSES#${fromId}`
        const exist = await client.sismember(key, courseId)
        if(!exist) {
            msger.say(`还没有关注${courseId}啦！`)
        }
        else {
            client.srem(key, courseId)
            msger.say(`成功取关${courseId}啦！`)
        }
    }


    async onMessage(msg, payload) {
        if(payload.toId != this.wxid){ // send from myself
            assert.equal(payload.fromId, this.wxid)
            return
        }
        if(payload.type != 7)   // not text
            return

        const { fromId, text } = payload;
        switch(true) {  // https://stackoverflow.com/questions/2896626
            case /^peek peek peek$/.test(text):
                this._check(fromId, msg)
                break;
            case /^register$/.test(text):
                this._register(fromId, msg)
                break
            case /^showall$/.test(text):
                this._showall(fromId, msg)
                break
            case /^focus [A-Z0-9]+$/i.test(text):
                var cid = text.split(' ')[1].toUpperCase()
                this._add(fromId, cid, msg)
                break
            case /^loose [A-Z0-9]+$/i.test(text):
                var cid = text.split(' ')[1].toUpperCase()
                this._drop(fromId, cid, msg)
                break
        }
    }

    constructor(name='checker') {
        const DEFAULT_PUPPET = true
        if(DEFAULT_PUPPET) {
            this.bot = new Wechaty({ name: name })
        }
        else {
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
    .catch(err => {
        log.error('CheckerBot', err)
        client.end(true)
    })
