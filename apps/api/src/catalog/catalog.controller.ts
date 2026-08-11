import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/decorators';
import { CatalogService } from './catalog.service';
import {
  CreateCustomerDto,
  CreateDriverDto,
  CreateOrderDto,
  CreateShippingCompanyDto,
  CreateVehicleDto,
  ListQueryDto,
} from './dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(@Query() query: ListQueryDto) {
    return this.catalog.listOrders(query);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.getOrder(id);
  }

  @Roles('ADMIN', 'DISPATCHER')
  @Post()
  create(@Body() dto: CreateOrderDto, @CurrentUser('id') userId: string) {
    return this.catalog.createOrder(dto, userId);
  }
}

@Controller('shipping-companies')
export class ShippingCompaniesController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list() {
    return this.catalog.listCompanies();
  }

  @Roles('ADMIN', 'DISPATCHER')
  @Post()
  create(@Body() dto: CreateShippingCompanyDto) {
    return this.catalog.createCompany(dto);
  }

  @Get('vehicles')
  vehicles(@Query('shippingCompanyId') companyId?: string) {
    return this.catalog.listVehicles(companyId);
  }

  @Roles('ADMIN', 'DISPATCHER')
  @Post('vehicles')
  createVehicle(@Body() dto: CreateVehicleDto) {
    return this.catalog.createVehicle(dto);
  }

  @Get('drivers')
  drivers(@Query('shippingCompanyId') companyId?: string) {
    return this.catalog.listDrivers(companyId);
  }

  @Roles('ADMIN', 'DISPATCHER')
  @Post('drivers')
  createDriver(@Body() dto: CreateDriverDto) {
    return this.catalog.createDriver(dto);
  }
}

@Controller('customers')
export class CustomersController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(@Query('search') search?: string) {
    return this.catalog.listCustomers(search);
  }

  @Roles('ADMIN', 'DISPATCHER')
  @Post()
  create(@Body() dto: CreateCustomerDto) {
    return this.catalog.createCustomer(dto);
  }
}
