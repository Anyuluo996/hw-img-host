import express from 'express'
import uploadRouter from './routes/upload'
import authRouter from './routes/auth'
import deleteRouter from './routes/delete'
import assetsRouter from './routes/assets'

const app = express()
// assets 路由需要原始字节 body（任意 Content-Type），必须在 express.json() 之前挂载，
// 否则全局 json 解析器会先消费掉请求流。
app.use('/assets', assetsRouter)
app.use(express.json())
app.use('/auth', authRouter)
app.use('/upload', uploadRouter)
app.use('/delete', deleteRouter)

export default app
